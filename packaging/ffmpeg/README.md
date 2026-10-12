# LGPL FFmpeg build

The shared app image builds FFmpeg 8.0.1 from the frozen upstream archive and
uses the same installed shared libraries for its command-line tools and
TorchCodec. `packaging/ffmpeg/build-contract.json` records the exact source
archive, configure options, ABI expectations, and the runtime codec libraries.

The configure step disables GPL, nonfree, and automatic external-library
selection. It enables only the LGPL LAME MP3 encoder and BSD-licensed Opus
library. FFmpeg's built-in audio codecs, formats, filters, and resampler remain
available; no GPL video codec or Rubber Band dependency is selected. The build
uses shared FFmpeg libraries so LGPL consumers can replace the libraries
without relinking the application. The image keeps the FFmpeg LGPL text and the
installed copyright records for its external codec libraries.

The Dockerfile reads two named build contexts. `ffmpeg-source` holds the FFmpeg 8.0.1 release tarball
(`https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz`, saved as `ffmpeg_8.0.1.orig.tar.xz`; the same file is the
original tarball of Ubuntu's `ffmpeg` 7:8.0.1-3ubuntu2 source package, as recorded in
`packaging/licenses/ffmpeg-source-artifacts.json`). `ffmpeg-debs` holds an exact copy of the nine files listed in
`packaging/main-cuda/ffmpeg-native.lock`, including the retained audio libraries and LeadVocal's `libsamplerate0`
dependency. `prepare_ffmpeg_contexts.py` in this folder makes both from the publishers' downloads and verifies
every size and SHA-256 (see `packaging/source-offer/README.md`); the build helper verifies them again before
invoking Buildx. The downloads stay outside Git. The build stage installs the exact direct compiler and codec
development package versions in `packaging/main-cuda/ffmpeg-build.lock`.

The Docker recipe is shared by CUDA and ROCm app images through
`DEPENDENCY_IMAGE`. Build each variant from its clean app-dependency image;
never inherit the prior GPL-enabled app image. The Dockerfile checks that its
parent does not already contain FFmpeg packages or FFmpeg shared libraries,
then installs only the new build outputs and the locked runtime audio package
set.

This is a build recipe and source record. The license notices for the whole package are in
`packaging/licenses/NOTICE.md`.
