# Vocalis licensing and third-party notices

This file says which license covers which part of the Vocalis Docker package, which parts carry copyleft terms, and where the notices and source for them are. It describes the images built from this repository: the main Vocalis image (NVIDIA CUDA and AMD ROCm builds), the Taproom image, and the satellite images (NVIDIA and AMD). It states the terms of the licenses as recorded by their publishers; it is not legal advice and does not certify that any particular use or redistribution complies.

The third-party open-source components in the images are used unmodified. Their source is published by their own projects or by Ubuntu and is not copied into the Vocalis source archive; the section [Where to get the source of the third-party components](#where-to-get-the-source-of-the-third-party-components) gives the address for each exact version, with its SHA-256 where a record has one. Everything we wrote, changed or built ourselves is in the source archive (see [Source code for the build you run](#source-code-for-the-build-you-run)).

**Reminder for forks and redistributors:** the Apache-2.0 license at the repository root does not cover every component in this package. Each component keeps its own license. Preserve the notices, pass on the license texts, and meet the source-code and network-source requirements that apply to the parts you redistribute or host. The scope reminder at the top of [`LICENSE`](../../LICENSE) points to the component license files; it does not change their terms.

## What each license covers

| Part | License | License file |
| --- | --- | --- |
| Vocalis application, GPU workers, helper scripts, satellite, and the Vocalis overlay on ACE-Step | Apache-2.0 | [`LICENSE`](../../LICENSE) |
| Taproom (built from SillyTavern) | AGPL-3.0 | [`source/taproom/LICENSE`](../../source/taproom/LICENSE) |
| SillyTavern Vault | AGPL-3.0 | [`source/vault/LICENSE`](../../source/vault/LICENSE) |
| Mnemosyne | AGPL-3.0-only | [`source/mnemosyne/LICENSE`](../../source/mnemosyne/LICENSE) |
| CacheLens | AGPL-3.0-only | [`source/cachelens/LICENSE`](../../source/cachelens/LICENSE) |
| MCP Client (`Moeblack/sillytavern-mcp-client`, with Vocalis changes) | AGPL-3.0 | [`source/mcp-client/LICENSE`](../../source/mcp-client/LICENSE); the changes are listed in [`DOWNSTREAM-CHANGES.md`](../../source/mcp-client/DOWNSTREAM-CHANGES.md) |
| Vocalis SillyTavern extension | AGPL-3.0-only | [`source/vocalis/sillytavern/extension/LICENSE`](../../source/vocalis/sillytavern/extension/LICENSE) |
| Libraries, runtimes, engines and model weights | Their own licenses | the sections below |

## Vocalis code: Apache-2.0

The **Apache License, Version 2.0** covers eligible code owned by Douglas Beachy, including the application, GPU workers, helpers, satellite and ACE overlay. The [Apache-2.0 terms](https://www.apache.org/licenses/LICENSE-2.0) require you to give recipients the license, keep applicable attribution and notices, and mark files you changed. Apache-2.0 does not relicense any third-party software, including FFmpeg, Taproom, the other AGPL parts, model weights or NVIDIA components.

Three dependencies were replaced:

- EPUB reading in Book uses Python's standard-library `zipfile` and `lxml` (BSD-3-Clause) instead of EbookLib (AGPL). EbookLib is not installed in any image.
- Chatterbox is installed as `chatterbox-tts` 0.1.7+vocalis.1, built from the MIT-licensed upstream source with one metadata-only change: the unused `pykakasi` requirement (GPL) is removed. No upstream source file is changed, and the upstream MIT license is inside the wheel. pykakasi is not installed in any image. The patch and wheel record are in [`../chatterbox/`](../chatterbox/).
- FFmpeg is a custom LGPL-only build (next sections) instead of the GPL-enabled Ubuntu package.

Engines that Vocalis runs keep their permissive licenses and notices: Chatterbox (MIT), Resemble Enhance (MIT), VoxCPM (Apache-2.0), ACE-Step (MIT), DeepFilterNet (Apache-2.0 or MIT, at the recipient's option), audio-separator (MIT, with a downstream patch of the version, one dependency declaration and one line of code, in `packaging/leadvocal`), Demucs (MIT), PANNs inference (MIT), and the DWT1D subset of `pytorch-wavelets`, which keeps its own scoped license. Their license files, and for several the source archive Vocalis built from, are in the main image under `/usr/share/licenses/vocalis/`.

## AGPL parts: Taproom, Vault, Mnemosyne, CacheLens, MCP Client, Vocalis extension

Taproom keeps SillyTavern's upstream AGPL-3.0 license and its exact declaration. Vault, Mnemosyne, CacheLens, the MCP Client and the Vocalis extension run inside Taproom and are AGPL as listed above. The Vocalis main application runs in a separate container and talks to Taproom over the network; that is a technical arrangement, not a statement about how the licenses interact.

In plain terms, the AGPL-3.0 asks for the following (read the license text for the exact terms):

- **If you redistribute** these parts, modified or not (for example an image or an archive that contains them), you give recipients the license text, keep the notices, and make the corresponding source available to them under the same license.
- **If you host** a modified version for other people to use over a network, you offer those users the corresponding source of your modified version (AGPL-3.0 section 13). Taproom's built-in source page ([below](#source-code-for-the-build-you-run)) is how an unmodified build makes that offer. If you change covered code, regenerate the source archive from your tree with [`build_source_offer.py`](../source-offer/build_source_offer.py) (see [`../source-offer/README.md`](../source-offer/README.md)) and serve it, so the page describes what you run.
- **Modifications to the MCP Client** are recorded in [`DOWNSTREAM-CHANGES.md`](../../source/mcp-client/DOWNSTREAM-CHANGES.md).

Taproom's browser-side libraries keep their own notices in [`source/taproom/THIRD-PARTY-NOTICES.md`](../../source/taproom/THIRD-PARTY-NOTICES.md) and `source/taproom/third-party-licenses/`. In the Taproom image they are under `/opt/taproom/third-party-licenses/`. One of them, `jquery.ui.touch-punch`, is offered under MIT or GPL-2.0; both texts are included.

## Custom LGPL-only FFmpeg build

The `ffmpeg` and `ffprobe` programs and the FFmpeg shared libraries in the main Vocalis image (NVIDIA and AMD) are one custom build of **FFmpeg 8.0.1**, which is licensed LGPL-2.1-or-later. The build uses the unmodified upstream source (no patches) with these configure options: `--enable-shared --disable-static --enable-pic --disable-gpl --disable-nonfree --disable-autodetect --disable-ffplay --disable-doc --enable-libmp3lame --enable-libopus`. The external libraries are LAME (LGPL) for MP3 encoding and Opus (BSD) for Opus. GPL components such as x264, x265, Xvid, Rubber Band and vid.stab are not part of the build and no GPL FFmpeg library is installed in the image. The shared libraries (`libavcodec.so.62`, `libavformat.so.62`, `libavutil.so.60`, `libswresample.so.6`, `libswscale.so.9`, `libavfilter.so.11`, `libavdevice.so.62`) are in `/usr/local/lib`. ACE-Step's TorchCodec loads these same libraries into the GPU Python process, so the command-line tools and the in-process consumers use one build. The satellite images contain no FFmpeg.

The Ubuntu `libmp3lame0` (LAME 3.101) and `libmpg123-0t64` (mpg123, LGPL-2.1) libraries that the FFmpeg build loads, and `libopus0`, are installed from Ubuntu packages; their copyright files are under `/usr/share/doc/`.

**Source, recipe and replacement**

- FFmpeg source: the FFmpeg 8.0.1 release, <https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz> (11,388,848 bytes, SHA-256 `05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41`); the build names the file `ffmpeg_8.0.1.orig.tar.xz`. It is byte-for-byte the same file as the original tarball of the Ubuntu source package `ffmpeg` 7:8.0.1-3ubuntu2, <https://archive.ubuntu.com/ubuntu/pool/universe/f/ffmpeg/ffmpeg_8.0.1.orig.tar.xz> (same size and SHA-256, compared on October 11, 2026; see [`ffmpeg-source-artifacts.json`](ffmpeg-source-artifacts.json)). The Taproom source page links the release above. The file itself is not inside the source archive.
- Build recipe: the `ffmpeg-build` stage of [`Dockerfile.app`](../main-cuda/Dockerfile.app), with the pinned build packages in [`ffmpeg-build.lock`](../main-cuda/ffmpeg-build.lock), the nine pinned runtime audio packages (size and SHA-256 each) in [`ffmpeg-native.lock`](../main-cuda/ffmpeg-native.lock), and an overview in [`../ffmpeg/README.md`](../ffmpeg/README.md) and [`../ffmpeg/build-contract.json`](../ffmpeg/build-contract.json). The stage reads the FFmpeg tarball and the locked `.deb` files through two named build contexts, `ffmpeg-source` and `ffmpeg-debs`. [`../ffmpeg/prepare_ffmpeg_contexts.py`](../ffmpeg/prepare_ffmpeg_contexts.py) prepares both contexts in a folder you name by downloading the tarball from the address above and the nine packages from the Ubuntu archive, and it refuses any file whose size or SHA-256 differs from the records; `packaging/build_main_app.py --ffmpeg-contexts <folder>` builds from that folder (see [`../source-offer/README.md`](../source-offer/README.md)).
- Replacement: the libraries are shared libraries, not linked into the programs that use them. To use your own FFmpeg, build FFmpeg 8 with the same library versions (the names above) and put the libraries in `/usr/local/lib` of a derived image.
- The image records the license text at `/usr/share/licenses/vocalis-g1/FFmpeg-LGPL-2.1.txt`, the configure options at `/usr/share/vocalis-g1/ffmpeg-configure-options.txt`, and the build packages at `/usr/share/vocalis-g1/ffmpeg-build-packages.txt`.

This follows [FFmpeg's licensing guidance](https://ffmpeg.org/legal.html); it does not change FFmpeg's license.

## Other copyleft and notice-requiring components in the images

Versions are those installed in the images. The package metadata or the component's own notice is the authority for each license.

**LGPL**

| Component | Where | License | Notice and source |
| --- | --- | --- | --- |
| soxr 1.1.0 (Python wheel with libsoxr 0.1.3) | Python environments of the main and satellite images | LGPL-2.1-or-later (libsoxr also carries a PFFFT notice) | License files in the wheel's `dist-info/licenses/`; source address in the tables below (record: [`runtime-source-artifacts.json`](runtime-source-artifacts.json)); full text in [`LGPL-2.1.txt`](LGPL-2.1.txt) |
| libsndfile 1.2.2 inside the `soundfile` 0.14.0 wheel (`_soundfile_data/libsndfile_x86_64.so`), built with static LAME 3.100, mpg123 1.32.3, libogg 1.3.5, libvorbis 1.3.7, FLAC 1.4.3 and Opus 1.4 | Python environments of the main and satellite images | libsndfile, LAME and mpg123: LGPL; the Xiph libraries: BSD-3-Clause | `COPYING` in `_soundfile_data/`; build recipe, versions and source addresses in the tables below (record: [`soundfile-native-source-artifacts.json`](soundfile-native-source-artifacts.json)); full text in [`LGPL-2.1.txt`](LGPL-2.1.txt) |
| libsndfile1 1.2.2, libmp3lame0 3.101, libmpg123, libopus0, libflac, libogg, libvorbis, libsamplerate0 | Ubuntu packages in the main image | LGPL and BSD, per package | `/usr/share/doc/<package>/copyright`; exact source versions, and how to fetch them, under Ubuntu packages below (record: [`apt-runtime-source-artifacts.json`](apt-runtime-source-artifacts.json)) |
| lameenc 1.8.4 (with LAME 3.100) | Stems environment of the main image | LGPL-3.0-or-later | The lameenc and LAME source archives and license texts are in the image at `/usr/share/licenses/vocalis/stems/source/`, and their publisher addresses are in the tables below; full text in [`LGPL-3.0.txt`](LGPL-3.0.txt) |
| frozendict 2.4.7 | ACE-Step environment of the main image | LGPL-3.0 | License file in the package's `dist-info/licenses/`; source address in the tables below (record: [`runtime-source-artifacts.json`](runtime-source-artifacts.json)); full text in [`LGPL-3.0.txt`](LGPL-3.0.txt) |
| libquadmath, shipped in the NumPy and SciPy wheels | Python environments | LGPL-2.1-or-later | The wheels' `dist-info/LICENSE.txt`; every copy in the images (NumPy 1.26.4, 2.3.5 and 2.5.3; SciPy 1.17.0, 1.17.1 and 1.18.1), with its source, is recorded in [`numpy-scipy-native-source-artifacts.json`](numpy-scipy-native-source-artifacts.json) and listed in the tables below; full text in [`LGPL-2.1.txt`](LGPL-2.1.txt) |
| ip-matching 2.1.2 | Taproom image (an npm dependency of Taproom) | LGPL-3.0-only | It is installed as source and compiled JavaScript with its `src/` directory; npm tarball address in the tables below (record: [`runtime-source-artifacts.json`](runtime-source-artifacts.json)); full text in [`LGPL-3.0.txt`](LGPL-3.0.txt) (it incorporates [`GPL-3.0.txt`](GPL-3.0.txt)) |

**Satellite images:** the satellite image (NVIDIA and AMD) carries the same LGPL libraries as the main image, and their source locations are in this same document, in the section [Where to get the source of the third-party components](#where-to-get-the-source-of-the-third-party-components).

**GPL with a runtime-library exception, and the Ubuntu base**

- The `libgfortran` and `libgomp` copies inside the NumPy, SciPy, scikit-learn and PyTorch wheels are GPL-3.0-or-later with the GCC Runtime Library Exception; the Ubuntu `libstdc++6`, `libgcc-s1` and `libgomp1` packages are under the same license and exception. NumPy's and SciPy's license files reproduce the notices. The source of each copy in the images is listed under GCC runtime libraries inside the Python wheels below; where a copy's package build could not be named, the table says so and gives GCC's public source tree.
- The images are built on Ubuntu 26.04. Its packages (for example `libc6`, `bash`, `coreutils`, `tar`, `sed`, `grep`, `util-linux`) keep their own licenses, recorded in `/usr/share/doc/<package>/copyright`. [`apt-runtime-source-artifacts.json`](apt-runtime-source-artifacts.json) lists the Ubuntu source package, version, archive URL, size and SHA-256 for every package installed in the NVIDIA main, Taproom and NVIDIA satellite images, and the two development packages that the AMD images add, `linux-libc-dev` (source package `linux` 7.0.0-38.38) and `rpcsvc-proto` (1.4.3-1build1). How to fetch the source of a package is under Ubuntu packages below.

**MPL, CC BY and other notice-requiring components**

- `certifi`, `tqdm` (MPL-2.0 and MIT) and `orjson` (MPL-2.0 and Apache-2.0 or MIT) in the Python environments, and `dompurify` in Taproom (MPL-2.0 or Apache-2.0), carry their license files in their package directories. Their source addresses, by exact version, are in the tables below.
- **TaffyDB 2.6.2**, nested under protobufjs' CLI dependencies in Taproom, has no package license field or license file. Its `taffy.js` begins with a BSD-style grant that requires keeping the notice; the exact 1,155-byte notice is preserved in [`taffydb-2.6.2-header.txt`](taffydb-2.6.2-header.txt).
- **Taproom's SQLite stack:** `better-sqlite3-multiple-ciphers` 12.11.1 (MIT) with SQLite3 Multiple Ciphers 2.3.5 (MIT, with embedded third-party notices) and `sqlite-vec` 0.1.9 (MIT or Apache-2.0). The notice texts are in [`sqlite/`](sqlite/) and the source records in [`taproom-sqlite-source-artifacts.json`](taproom-sqlite-source-artifacts.json). The cipher is part of SQLite3 Multiple Ciphers; no separate SQLCipher library is linked. Source addresses are in the tables below.
- `caniuse-lite` (Taproom dependency) is CC-BY-4.0. The Trim scorer model and its class labels are CC BY 4.0 (see Model weights).
- **AMD ROCm 7.14.1** (the AMD images): the ROCm libraries and tools come as AMD's ROCm Python wheels and keep their own licenses, which differ by component. The wheels carry their notices (under `share/doc/`); for the AMD main image the component notices are also collected at `/usr/share/licenses/vocalis/stems/rocm/`, and they are in [`rocm/`](rocm/) with the record in [`rocm-notice-artifacts.json`](rocm-notice-artifacts.json). PyTorch is BSD-3-Clause; its `LICENSE` and `NOTICE` are in its `dist-info`. The ROCm source repositories at the pinned revisions are in the tables below. In the AMD satellite image the same notices are at `/usr/share/licenses/vocalis-g1/rocm/`, with the record at `/usr/share/licenses/vocalis-g1/rocm-notice-artifacts.json`.

### License texts inside the images

- **Main images (NVIDIA and AMD):** `/usr/share/licenses/vocalis-g1/` holds `GPL-3.0.txt`, `LGPL-2.1.txt` and `LGPL-3.0.txt` (copies of the files in this folder), `FFmpeg-LGPL-2.1.txt`, `Vocalis-LICENSE`, and, in the NVIDIA image, `nvidia-ml-py-LICENSE.txt`. The engines' own license files are under `/usr/share/licenses/vocalis/`, the model notices under `/usr/share/licenses/vocalis-g1/models/`, and, in the AMD image, the ROCm notices under `/usr/share/licenses/vocalis/stems/rocm/`.
- **Taproom image:** `/usr/share/licenses/vocalis-g1/` holds `LGPL-3.0.txt` and `GPL-3.0.txt` (for ip-matching), the folder `sqlite/` (the notices for better-sqlite3-multiple-ciphers, SQLite3 Multiple Ciphers and sqlite-vec, with sqlite-vec's MIT and Apache-2.0 texts), and the AGPL parts' license files. The browser-side libraries' notices are under `/opt/taproom/third-party-licenses/`.
- **Satellite images:** `/usr/share/licenses/vocalis-g1/` holds `LGPL-2.1.txt`, `GPL-3.0.txt`, `Vocalis-LICENSE` and the Chatterbox model notice; the NVIDIA image adds `nvidia-ml-py-LICENSE.txt`, and the AMD image adds the folder `rocm/` and `rocm-notice-artifacts.json`.

## Where to get the source of the third-party components

The third-party components below are used unmodified. This section gives, for each one whose license asks for its source to be available, the address of the source for the exact version in the images. Where a record has a SHA-256 (or an npm integrity value) for the file, it is shown; the records in this folder hold the same addresses with sizes and more detail. Components that carry a license but ask only for the notice to be kept (the BSD, MIT and Apache libraries in the Python environments and in Taproom) are not listed here; their notices are in their package directories in the images.

The satellite images (NVIDIA and AMD) carry the same LGPL libraries as the main image; their source locations are the ones in this section.

### Python libraries, and libraries built into Python wheels

| Component and version | Source | SHA-256 |
| --- | --- | --- |
| soxr 1.1.0 (contains libsoxr 0.1.3 and PFFFT) | <https://files.pythonhosted.org/packages/ed/11/27cebce4a108f77afea7c80545115536b45e3f11ebfb914f638fdd9ba847/soxr-1.1.0.tar.gz> | `9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44` |
| python-soundfile 0.14.0 (the wheel that carries the libraries below) | <https://github.com/bastibe/python-soundfile/tree/0.14.0> | git tag |
| Build script and recipe for the libsndfile library inside that wheel (`linux_build.sh`, libsndfile-binaries revision `a3e6f9769d0c`) | <https://raw.githubusercontent.com/bastibe/libsndfile-binaries/a3e6f9769d0c7e91d2d036cf0fdbe5b4bbf18b87/linux_build.sh> | `90709951b06174c4eebc201419e3671e65ec4ef38a279c34a1e9d3dd2bf33bde` |
| libogg 1.3.5 (built into the soundfile wheel's libsndfile) | <https://downloads.xiph.org/releases/ogg/libogg-1.3.5.tar.gz> | `0eb4b4b9420a0f51db142ba3f9c64b333f826532dc0f48c6410ae51f4799b664` |
| libvorbis 1.3.7 (built into the soundfile wheel's libsndfile) | <https://downloads.xiph.org/releases/vorbis/libvorbis-1.3.7.tar.gz> | `0e982409a9c3fc82ee06e08205b1355e5c6aa4c36bca58146ef399621b0ce5ab` |
| FLAC libFLAC component 1.4.3 (built into the soundfile wheel's libsndfile) | <https://github.com/xiph/flac/releases/download/1.4.3/flac-1.4.3.tar.xz> | `6c58e69cd22348f441b861092b825e591d0b822e106de6eb0ee4d05d27205b70` |
| Opus 1.4 (built into the soundfile wheel's libsndfile) | <https://downloads.xiph.org/releases/opus/opus-1.4.tar.gz> | `c9b32b4253be5ae63d1ff16eea06b94b5f0f2951b7a02aceef58e3a3ce49c51f` |
| mpg123 libmpg123 component 1.32.3 (built into the soundfile wheel's libsndfile) | <https://sourceforge.net/projects/mpg123/files/mpg123/1.32.3/mpg123-1.32.3.tar.bz2/download> | `2d9913a57d4ee8f497a182c6e82582602409782a4fb481e989feebf4435867b4` (observed; the archive has a detached signature at <https://www.mpg123.org/download/mpg123-1.32.3.tar.bz2.sig>, made with the key whose published fingerprint is `D021FF8ECF4BE09719D61A27231C4CBC60D5CAFE`) |
| LAME libmp3lame component 3.100 (built into the soundfile wheel's libsndfile) | <https://sourceforge.net/projects/lame/files/lame/3.100/lame-3.100.tar.gz/download> | `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e` (observed; the publisher does not publish one) |
| libsndfile 1.2.2 (built into the soundfile wheel's libsndfile) | <https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2.tar.xz> | `3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e` (observed; the publisher does not publish one) |
| lameenc 1.8.4 (Stems environment; also in the image at `/usr/share/licenses/vocalis/stems/source/`) | <https://codeload.github.com/chrisstaite/lameenc/tar.gz/refs/tags/v1.8.4> | `70c7a23830c98139f2b8e2ebdd56990b3e8e50bb8eaf22daa7b8861b1f6bffcb` |
| LAME 3.100 (built into lameenc; also in that image folder) | <https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz> | `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e` |
| frozendict 2.4.7 (ACE-Step environment) | <https://files.pythonhosted.org/packages/90/b2/2a3d1374b7780999d3184e171e25439a8358c47b481f68be883c14086b4c/frozendict-2.4.7.tar.gz> | `e478fb2a1391a56c8a6e10cc97c4a9002b410ecd1ac28c18d780661762e271bd` |

### GCC runtime libraries inside the Python wheels

| Library copies | Source package | SHA-256 |
| --- | --- | --- |
| libgfortran and libquadmath, GNU build IDs `5bbe74eb...` and `549b4c82...`: NumPy 1.26.4 and 2.3.5, SciPy 1.17.0, 1.17.1 and 1.18.1 (first copies) | <https://buildlogs.cdn.centos.org/c7.1908.00.x86_64/gcc-libraries/20190808232852/8.3.1-2.1.1.el7.x86_64/gcc-libraries-8.3.1-2.1.1.el7.src.rpm> | `4d3e523f8b8588ee4432b796b6e12f62b022e2c1cdda92668bb6965f397f27cb` |
| (same copies, second source package) | <https://vault.centos.org/7.9.2009/os/Source/SPackages/gcc-4.8.5-44.el7.src.rpm> | `642c4085f6af9565e39583e54a9d7a5d9e6b93dd8c8e9474aec8a892d6c7aa36` |
| libgfortran and libquadmath, build IDs `7a1cb857...` and `84f2ad82...`: SciPy 1.17.0 and 1.17.1 (second copies) | <https://vault.almalinux.org/8.10/BaseOS/Source/Packages/gcc-8.5.0-26.el8_10.alma.1.src.rpm> | `0911864c260a75ae030f3144616e7e5e1359e04ce1c9730ab83906486e3bc79f` |
| libgfortran and libquadmath, build IDs `04dbe32d...` and `c1c5f8d6...`: NumPy 2.5.3 and SciPy 1.18.1; libgomp, build ID `2244452c...`: scikit-learn 1.9.1 and PyTorch 2.10.0 | <https://vault.almalinux.org/8.10/BaseOS/Source/Packages/gcc-8.5.0-28.el8_10.alma.1.src.rpm> | `c94dbbd2cd6d5d01a5a6822ea18f8ce34942c25a80e17b4682d547d5e652dbd0` |
| libgomp, build ID `5f4fb88a...`: PyTorch 2.6.0 wheels (the library records no package version) | GCC's public source tree <https://gcc.gnu.org/git/?p=gcc.git;a=tree;f=libgomp> and release archives <https://ftp.gnu.org/gnu/gcc/> | none recorded |

The CentOS source packages in the first two rows are matched to the copies by GNU build ID. The AlmaLinux source packages are named by the debug-link string recorded inside each library (for example `libgfortran.so.5.0.0-8.5.0-28.el8_10.alma.1.x86_64.debug`); the build IDs were not compared with the AlmaLinux binary packages. The build ID and the SHA-256 of every copy, as read from the NVIDIA main image, are in [`numpy-scipy-native-source-artifacts.json`](numpy-scipy-native-source-artifacts.json). The wheels' own license files give GCC's public source tree (`https://gcc.gnu.org/git/?p=gcc.git;a=tree`) as the availability of these libraries.

### NumPy, SciPy and scikit-learn releases

| Release | Source | SHA-256 |
| --- | --- | --- |
| numpy-1.26.4 | <https://files.pythonhosted.org/packages/65/6e/09db70a523a96d25e115e71cc56a6f9031e7b8cd166c1ac8438307c14058/numpy-1.26.4.tar.gz> | `2a02aba9ed12e4ac4eb3ea9421c420301a0c6460d9830d74a9df87efa4912010` |
| scipy-1.17.1 | <https://files.pythonhosted.org/packages/7a/97/5a3609c4f8d58b039179648e62dd220f89864f56f7357f5d4f45c29eb2cc/scipy-1.17.1.tar.gz> | `95d8e012d8cb8816c226aef832200b1d45109ed4464303e997c5b13122b297c0` |
| numpy-2.3.5 | <https://files.pythonhosted.org/packages/76/65/21b3bc86aac7b8f2862db1e808f1ea22b028e30a225a34a5ede9bf8678f2/numpy-2.3.5.tar.gz> | `784db1dcdab56bf0517743e746dfb0f885fc68d948aba86eeec2cba234bdf1c0` |
| scipy-1.17.0 | <https://files.pythonhosted.org/packages/56/3e/9cca699f3486ce6bc12ff46dc2031f1ec8eb9ccc9a320fdaf925f1417426/scipy-1.17.0.tar.gz> | `2591060c8e648d8b96439e111ac41fd8342fdeff1876be2e19dea3fe8930454e` |
| numpy-2.5.3 | <https://files.pythonhosted.org/packages/13/01/11703282db468b85f6f7b8c7f22d058de5970d5c7e60a3a8aaa313c3de36/numpy-2.5.3.tar.gz> | `df2d5874ff183595a4ba404edd04f6bd9b5505c1d7708573f6a6c17489a67563` |
| scipy-1.18.1 | <https://files.pythonhosted.org/packages/7e/74/66de6258867beb2ef08f35f9f2ac017a52cacd5081714d239ff1a442d458/scipy-1.18.1.tar.gz> | `52c4b7422442aba924d03ad4019852b08a92e64ea187b933135687bfe2747307` |
| scikit-learn-1.9.1 | <https://files.pythonhosted.org/packages/d2/eb/eaf5e07fcc0da7149b0e084f24e54edd7441b9a89ce7e034032ae97fe3a0/scikit_learn-1.9.1.tar.gz> | `629cada3e33e2b9bf376cdc7614a47a4140b8aedc1d836579e359736fbd82977` |

### MPL-licensed packages

| Package and version | Source | SHA-256 |
| --- | --- | --- |
| certifi 2022.12.7 | <https://files.pythonhosted.org/packages/37/f7/2b1b0ec44fdc30a3d31dfebe52226be9ddc40cd6c0f34ffc8923ba423b69/certifi-2022.12.7.tar.gz> | `35824b4c3a97115964b408844d64aa14db1cc518f6562e8d7261699d1350a9e3` |
| certifi 2026.1.4 | <https://files.pythonhosted.org/packages/e0/2d/a891ca51311197f6ad14a7ef42e2399f36cf2f9bd44752b3dc4eab60fdc5/certifi-2026.1.4.tar.gz> | `ac726dd470482006e014ad384921ed6438c457018f4b3d204aea4281258b2120` |
| certifi 2026.7.22 | <https://files.pythonhosted.org/packages/a3/c2/24167ea9858356b47a87a50d39908bfdb72ceeefe0041586e704e5376b3a/certifi-2026.7.22.tar.gz> | `741e2c3b351ddf169a738da9f2c048608ff7f2c5cc02f1ebc6b118bb090d5d55` |
| tqdm 4.66.5 | <https://files.pythonhosted.org/packages/58/83/6ba9844a41128c62e810fddddd72473201f3eacde02046066142a2d96cc5/tqdm-4.66.5.tar.gz> | `e1020aef2e5096702d8a025ac7d16b1577279c9d63f8375b63083e9a5f0fcbad` |
| tqdm 4.67.1 | <https://files.pythonhosted.org/packages/a8/4b/29b4ef32e036bb34e4ab51796dd745cdba7ed47ad142a9f4a1eb8e0c744d/tqdm-4.67.1.tar.gz> | `f8aef9c52c08c13a65f30ea34f4e5aac3fd1a34959879d7e59e63027286627f2` |
| tqdm 4.70.1 | <https://files.pythonhosted.org/packages/0d/ea/b2a5bd54b28a324dae8211928b2d730b6547500342c7e6c6dea08bd0a485/tqdm-4.70.1.tar.gz> | `cefd0eca11b2a37a3aee776544d4f4ae913f02688135b5556b8788dfa474afc4` |
| orjson 3.13.0 | <https://files.pythonhosted.org/packages/f2/72/380b97dc45bd162d23afe5194721ef678d9eac7cfaa549fe2873f7f0a518/orjson-3.13.0.tar.gz> | `d1de5eb04485110c5da4c657e49168995d55e076b1ce60f1a042e254f4186c4f` |
| dompurify 3.4.2 (Taproom) | <https://registry.npmjs.org/dompurify/-/dompurify-3.4.2.tgz> | `sha512-lHeS9SA/IKeIFFyYciHBr2n0v1VMPlSj843HdLOwjb2OxNwdq9Xykxqhk+FE42MzAdHvInbAolSE4mhahPpjXA==` (npm integrity) |

### Taproom: npm packages

| Package and version | Source | SHA-256 |
| --- | --- | --- |
| ip-matching 2.1.2 (the npm package carries its TypeScript source in `src/`) | <https://registry.npmjs.org/ip-matching/-/ip-matching-2.1.2.tgz> | `7cfac6ba28384f2278f92fbef10e4fdc98ed774f3b288ccb2ddf7ffe34457b9a` |
| better-sqlite3-multiple-ciphers 12.11.1 | <https://registry.npmjs.org/better-sqlite3-multiple-ciphers/-/better-sqlite3-multiple-ciphers-12.11.1.tgz> | `01388c78f46ce63c6aec021f67b364cc67bd637edba64f7add0c0230ce5f777a` |
| sqlite-vec 0.1.9 | <https://registry.npmjs.org/sqlite-vec/-/sqlite-vec-0.1.9.tgz> | `99ae8b2159aa2d25a0186b7b07d8ef21478370af2f9755d905f8055f8b67307b` |
| sqlite-vec-linux-x64 0.1.9 | <https://registry.npmjs.org/sqlite-vec-linux-x64/-/sqlite-vec-linux-x64-0.1.9.tgz> | `d75c33662b3ce690d122a5f4285a3acf2f6ba288c46331a7b1fad593b6da2908` |
| SQLite3 Multiple Ciphers 2.3.5 (compiled from the amalgamation inside the better-sqlite3-multiple-ciphers package) | <https://github.com/utelle/SQLite3MultipleCiphers/tree/e74443388638a1557e2c506a631df7cf01251980> | git commit |
| sqlite-vec 0.1.9 | <https://github.com/asg017/sqlite-vec/tree/e9f598abfa0c06b328d8fe5da9c3760cce74be10> | git commit |

### AMD ROCm 7.14.1

| Repository | Source at the pinned revision | Revision type |
| --- | --- | --- |
| TheRock (the ROCm 7.14.1 wrapper source) | <https://github.com/ROCm/TheRock/tree/f51dc6c91e0d3214f22853fd5cb3f96dbc7d2c4b> | git commit |
| rocm-libraries | <https://github.com/ROCm/rocm-libraries/tree/cd9574023093742434e8c992d13b89ab9a6c1cf8> | git commit |
| rocm-systems | <https://github.com/ROCm/rocm-systems/tree/ca887ee80abfb82671fe1d6d8da708a713438e05> | git commit |

### Ubuntu packages

The images are built on Ubuntu 26.04 and install its packages unmodified. [`apt-runtime-source-artifacts.json`](apt-runtime-source-artifacts.json) lists, for the packages installed in the NVIDIA main, AMD main and Taproom images, every file of the matching Ubuntu source package (the `.dsc`, the original tarball with its signature, and the Debian changes) with its address, size and SHA-256, and the source package and version it belongs to. This includes `linux-libc-dev` (source package `linux` 7.0.0-38.38) and `rpcsvc-proto` (1.4.3-1build1), which the AMD images add.

To fetch the source of a package in an image:

1. Find its source package and version: `dpkg-query -W -f='${source:Package} ${source:Version}\n' <package>` inside the image.
2. Find that source package and version in the `sourcePackages` entries of the JSON file. Each row's `url` is the file at `https://archive.ubuntu.com/ubuntu/`; download it and compare the size and SHA-256 in the row. The rows of one source package share a pool folder.
3. Alternatively, on Ubuntu 26.04 with source repositories enabled for `resolute`, `resolute-updates` and `resolute-security`, `apt-get source <source>=<version>` downloads and unpacks the same package.
4. If a version has left Ubuntu's pool, `https://launchpad.net/ubuntu/+source/<source>/<version>` (with the source package name and version filled in) lists the files of every published version with their checksums.

The libstdc++, libgcc and libgomp packages of the images come from the Ubuntu source package `gcc-16` (16-20260322-1ubuntu1), which is in the file.

## NVIDIA components

The NVIDIA images get their CUDA runtime libraries (cuBLAS, cuDNN, cuFFT, cuRAND, cuSOLVER, cuSPARSE, NCCL, NVRTC, NVTX, and related libraries) from the `nvidia-*` Python wheels that PyTorch depends on (CUDA 12.4 or 12.8, depending on the engine). They are NVIDIA's proprietary software under NVIDIA's terms, except where a package declares another license in its metadata (for example NCCL 2.27.5 and NVTX 12.8). The license texts are inside the packages (in their `dist-info` directories, usually as `License.txt`, or beside the libraries). Apache-2.0 does not apply to them. The NVIDIA driver and CUDA toolkit are not in any image.

### NVIDIA NVML bindings (nvidia-ml-py)

**nvidia-ml-py 13.615.71** (module `pynvml`) is licensed under the BSD 3-Clause license, Copyright NVIDIA Corporation. Vocalis uses it to ask the NVIDIA driver for whole-card memory and sensor readings (how much of a card is used in total, and its name, busy, temperature, power, clocks and fan), which PyTorch's own numbers do not show on Windows. It is a pure-Python wheel with no dependencies, installed in the NVIDIA main image and the NVIDIA satellite image only; the AMD images do not carry it. The wheel has no license file, so the license text reproduced from its module header is kept at [`../nvml/LICENSE-nvidia-ml-py.txt`](../nvml/LICENSE-nvidia-ml-py.txt) and installed in those two images at `/usr/share/licenses/vocalis-g1/nvidia-ml-py-LICENSE.txt`. The pinned wheel, its SHA-256 lock and its provenance note are in [`../nvml/`](../nvml/); the build installs it with no index and with hash checking.

## Model weights

No image and no source archive contains model weights. Setup downloads them from their publishers into the data folder (about 62.5 GB), checking every file against the size and SHA-256 pinned in the locks under [`../models/`](../models/) (see [`fetch_models.py`](../models/fetch_models.py)). Each model keeps its publisher's license; Vocalis's Apache-2.0 license does not apply to it. The model notices are in `../models/<model>/NOTICE.md` and, in the main image, at `/usr/share/licenses/vocalis-g1/models/`.

| Model | Publisher's stated license |
| --- | --- |
| Chatterbox (`ResembleAI/chatterbox`) | MIT |
| VoxCPM2 (`openbmb/VoxCPM2`) | Apache-2.0 (the model card also forbids use for impersonation, fraud or disinformation and asks that generated content be labeled) |
| Resemble Enhance | MIT |
| Trim scorer: PANNs Cnn14 checkpoint (Zenodo record 3576403) and the Google AudioSet class-label index | CC BY 4.0 (full text in [`../models/trim/CC-BY-4.0.txt`](../models/trim/CC-BY-4.0.txt)) |
| ACE-Step 1.5 (`ACE-Step/Ace-Step1.5`, with Qwen3-Embedding-0.6B and Qwen3-1.7B components, and the XL SFT and XL Base models `ACE-Step/acestep-v15-xl-sft` and `ACE-Step/acestep-v15-xl-base`) | MIT declared by each model repository; Apache-2.0 for the Qwen3 components and for the Apache-licensed code headers in the selected files |
| DeepFilterNet3 | The repository license (Apache-2.0 or MIT, at the recipient's option) covers the code and does not grant rights to the weights, whose redistribution is not settled; setup downloads them from the publisher |
| HTDemucs (`htdemucs`, model `955717e8`), used by Stems | The Demucs code is MIT-licensed. The author has written that the pretrained weights are not covered by that license and are provided for research or scientific purposes, and the current model card declares no license for them; their redistribution is not settled, and setup downloads the file from the publisher (see [`../models/stems/NOTICE.md`](../models/stems/NOTICE.md)) |
| Lead Vocal models: the UVR karaoke and de-reverb models and their parameter files, with the Roformer de-reverb models by anvuew | The Ultimate Vocal Remover project states that its code is MIT-licensed and asks users of its models to honor the MIT license by crediting UVR and its developers; no separate terms are stated for the individual files, whose redistribution is not settled, and setup downloads them from the publishers (see [`../models/leadvocal/NOTICE.md`](../models/leadvocal/NOTICE.md)) |

Taproom's Mnemosyne downloads its embedding model, the quantized Transformers.js conversion `Xenova/multi-qa-mpnet-base-cos-v1`, from Hugging Face on first use. Neither the conversion nor the base model declares a license, so none is asserted here. See [`../models/mnemosyne/NOTICE.md`](../models/mnemosyne/NOTICE.md).

## Source code for the build you run

**In the product:** Taproom's welcome panel and the User Settings area (beside the version) each have a **Source code for this build** link to `/source/index.html`, a page served by Taproom's own web server before sign-in, so it needs no account. The page shows the product version, the source revision, a download link for the archive `vocalis-<version>-source.zip` with its SHA-256, the license scope of each component, and the additional source materials.

**What the archive contains:** `LICENSE`, `README.md`, `SOURCE-MANIFEST.json` (every file with its size, mode and SHA-256, the source revision and the component license scopes), `packaging/` (Dockerfiles, lock files, setup and installer sources, model locks and notices, and this licenses folder with this document, its records and the license texts), and `source/` (the sources of Taproom, Vault, Mnemosyne, CacheLens, the MCP Client and the Vocalis extension, each with its `LICENSE`). Its files are stored uncompressed in a fixed order so the same inputs give the same archive. It does not contain model weights, the source of FFmpeg or of the other third-party components (they are used unmodified, and the section above says where each one's source is published), or the Vocalis application source under `source/vocalis/` apart from the extension (the Apache-2.0 application code is in this repository). The archive does contain the patched Chatterbox wheel's recipe and patch, the custom FFmpeg build recipe and its locks, and the other things we changed or built ourselves.

**The third-party components on the page:** the page has an entry stating that the third-party open-source components in this build are used unmodified and that this document, with its records beside it, lists where each one's source is. It links this document as served by Taproom at `/source/NOTICE.md` (links inside it to other files refer to the same files inside the archive, where it is `packaging/licenses/NOTICE.md`). The FFmpeg entry links the official release tarball with its SHA-256; the build recipe and locks for it are in the archive.
