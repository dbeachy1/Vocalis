# syntax=docker/dockerfile:1.6
# Build this layer only from the locally verified dependency image and named
# source/model contexts; the default context contains no application or artifacts.
ARG DEPENDENCY_IMAGE=vocalis-g1-main-cuda-deps:20261008
FROM ${DEPENDENCY_IMAGE} AS ffmpeg-build

# Build one shared LGPL-only FFmpeg 8 toolchain for the CLI and TorchCodec.
COPY ffmpeg-build.lock /usr/share/vocalis-g1/ffmpeg-build.lock
RUN apt-get update \
 && xargs -r apt-get install -y --no-install-recommends < /usr/share/vocalis-g1/ffmpeg-build.lock \
 && rm -rf /var/lib/apt/lists/*

RUN --mount=type=bind,from=ffmpeg-source,target=/ffmpeg-source,readonly \
    set -eu; \
    printf '%s  %s\n' '05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41' '/ffmpeg-source/ffmpeg_8.0.1.orig.tar.xz' | sha256sum -c -; \
    mkdir -p /tmp/ffmpeg-source; \
    tar -xf /ffmpeg-source/ffmpeg_8.0.1.orig.tar.xz -C /tmp/ffmpeg-source; \
    cd /tmp/ffmpeg-source/ffmpeg-8.0.1; \
    ./configure \
      --prefix=/usr/local \
      --libdir=/usr/local/lib \
      --shlibdir=/usr/local/lib \
      --enable-shared \
      --disable-static \
      --enable-pic \
      --disable-gpl \
      --disable-nonfree \
      --disable-autodetect \
      --disable-ffplay \
      --disable-doc \
      --enable-libmp3lame \
      --enable-libopus; \
    make -j2; \
    make install; \
    install -D -m 0644 COPYING.LGPLv2.1 /usr/share/licenses/vocalis-g1/FFmpeg-LGPL-2.1.txt; \
    rm -rf /usr/local/include /usr/local/lib/pkgconfig /usr/local/share /usr/local/lib/*.a; \
    dpkg-query -W -f='${binary:Package}=${Version}\n' \
      build-essential gcc g++ make nasm pkgconf pkgconf-bin xz-utils \
      libmp3lame-dev libopus-dev > /usr/share/vocalis-g1/ffmpeg-build-packages.txt; \
    printf '%s\n' \
      '--prefix=/usr/local' '--libdir=/usr/local/lib' '--shlibdir=/usr/local/lib' \
      '--enable-shared' '--disable-static' '--enable-pic' \
      '--disable-gpl' '--disable-nonfree' '--disable-autodetect' \
      '--disable-ffplay' '--disable-doc' '--enable-libmp3lame' '--enable-libopus' \
      > /usr/share/vocalis-g1/ffmpeg-configure-options.txt

FROM ${DEPENDENCY_IMAGE} AS vocalis-app

ARG APP_PROFILE=cuda
ARG APP_PRIMARY_PYTHON=/opt/venv/3.12/bin/python
ARG VOCALIS_UID=1000
ARG VOCALIS_GID=1000

LABEL com.vocalis.profile=${APP_PROFILE}

WORKDIR /opt/vocalis

# CUDA and ROCm app-dependency bases use different primary venv roots. Verify
# the selected profile against PATH because the server entrypoint invokes python.
RUN set -eu; \
    case "${APP_PROFILE}" in \
      cuda) expected=/opt/venv/3.12/bin/python ;; \
      rocm) expected=/opt/venv/chatterbox/bin/python ;; \
      *) echo "unsupported app profile: ${APP_PROFILE}" >&2; exit 1 ;; \
    esac; \
    test "${APP_PRIMARY_PYTHON}" = "${expected}"; \
    test "$(command -v python)" = "${expected}"; \
    test -x "${expected}"; \
    "${expected}" -c 'import sys; assert sys.version_info[:3] == (3, 12, 15), sys.version'

# The dependency image is the clean pre-FFmpeg app-deps boundary. Fail if a
# lower layer already supplies FFmpeg or its shared libraries.
RUN if dpkg-query -W -f='${binary:Package}\n' 2>/dev/null \
      | grep -E '^(ffmpeg|libav(codec|device|filter|format|util)([0-9]+t64|[0-9]+)?|libsw(resample|scale)([0-9]+t64|[0-9]+)?|libx264(-[0-9]+)?|libx265(-[0-9]+)?|libxvidcore[0-9]*|librubberband[0-9]*|libvidstab[0-9]*([.][0-9]+)?)(:[^[:space:]]+)?$'; then \
      echo 'unexpected preinstalled FFmpeg/GPL codec package in dependency image' >&2; exit 1; \
    fi; \
    if ldconfig -p | grep -E 'lib(av(codec|device|filter|format|util)|sw(resample|scale))\.so'; then \
      echo 'unexpected preinstalled FFmpeg shared library in dependency image' >&2; exit 1; \
    fi

# Layer order matters for storage: the engine environments are tens of GB, so
# they sit below the FFmpeg layers and the app source. An ordinary source edit
# then rebuilds only the small layers at the end instead of re-copying them.
#
# Keep the retained model environments isolated from the app venv. Each named
# context is a previously built, hash-locked component image supplied by the
# assembly helper; the contexts are required inputs, not optional features.
COPY --from=voxcpm-engine /opt/vocalis/venvs/voxcpm2 /opt/vocalis/venvs/voxcpm2
COPY --from=enhance-engine /opt/vocalis/venvs/enhance /opt/vocalis/venvs/enhance
COPY --from=trim-engine /opt/vocalis/venvs/trim /opt/vocalis/venvs/trim
COPY --from=stems-engine /opt/vocalis/venvs/stems /opt/vocalis/venvs/stems
COPY --from=leadvocal-engine /opt/vocalis/venvs/leadvocal /opt/vocalis/venvs/leadvocal
COPY --from=acestep-engine /opt/venvs/acestep /opt/venvs/acestep
COPY --from=acestep-engine /opt/acestep /opt/acestep
COPY --from=dfn-engine /opt/dfn-venv /opt/dfn-venv

# DFN3 uses its pinned CPython 3.11.17 runtime. Copy only its 3.11 runtime
# subtree; the clean app base retains its independent /opt/python/3.12.15.
COPY --from=dfn-engine /opt/python/bin/python3.11 /opt/python/bin/python3.11
COPY --from=dfn-engine /opt/python/lib /opt/python/lib

# Carry the component licenses and provenance with the runtime environments.
COPY --from=enhance-engine /usr/share/licenses/vocalis/enhance /usr/share/licenses/vocalis/enhance
COPY --from=trim-engine /usr/share/licenses/vocalis/trim /usr/share/licenses/vocalis/trim
COPY --from=stems-engine /usr/share/licenses/vocalis/stems /usr/share/licenses/vocalis/stems
COPY --from=leadvocal-engine /usr/share/licenses/vocalis/leadvocal /usr/share/licenses/vocalis/leadvocal
COPY --from=acestep-engine /usr/share/licenses/vocalis/acestep /usr/share/licenses/vocalis/acestep
COPY --from=dfn-notices / /usr/share/licenses/vocalis/dfn/

# The VoxCPM2 component images predate per-component notice directories, and
# VoxCPM itself is copied in as source without package metadata. Rebuild its
# notices from tracked inputs: the hash-checked upstream archive (Apache-2.0)
# and the license files its installed distributions ship in the environment.
COPY --from=voxcpm-source /source-artifact.json /usr/share/licenses/vocalis/voxcpm2/source/source-artifact.json
COPY --from=voxcpm-source /source/ /usr/share/licenses/vocalis/voxcpm2/source/
RUN /opt/python/3.12.15/bin/python3.12 - <<'PY'
import hashlib
import json
import shutil
import tarfile
from pathlib import Path

root = Path("/usr/share/licenses/vocalis/voxcpm2")
record = json.loads((root / "source/source-artifact.json").read_text(encoding="utf-8"))
archive = root / "source" / f"VoxCPM-{record['revision']}.tar.gz"
if hashlib.sha256(archive.read_bytes()).hexdigest() != record["archiveSha256"]:
    raise SystemExit("VoxCPM source archive hash does not match its tracked record")
with tarfile.open(archive, "r:gz") as source:
    license_text = source.extractfile(f"VoxCPM-{record['revision']}/LICENSE").read()
if hashlib.sha256(license_text).hexdigest() != record["licenseSha256"]:
    raise SystemExit("VoxCPM LICENSE hash does not match its tracked record")
(root / "LICENSE").write_bytes(license_text)

site = next(Path("/opt/vocalis/venvs/voxcpm2/lib").glob("python3.*/site-packages"))
names = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS")
copied = 0
for dist in sorted(site.glob("*.dist-info")):
    for item in sorted(dist.rglob("*")):
        relative = item.relative_to(dist)
        if item.is_file() and ("licenses" in relative.parts[:-1] or item.name.upper().startswith(names)):
            target = root / "python" / dist.name / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(item, target)
            copied += 1
if not copied:
    raise SystemExit("No license files found in the VoxCPM2 environment")
print(f"VoxCPM2 notices: upstream LICENSE plus {copied} environment license files")
PY

COPY ffmpeg-native.lock /usr/share/vocalis-g1/ffmpeg-native.lock
COPY ffmpeg-build.lock /usr/share/vocalis-g1/ffmpeg-build.lock
COPY --from=ffmpeg-build /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-build /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg-build /usr/local/lib/ /usr/local/lib/
COPY --from=ffmpeg-build /usr/share/licenses/vocalis-g1/FFmpeg-LGPL-2.1.txt /usr/share/licenses/vocalis-g1/FFmpeg-LGPL-2.1.txt
COPY --from=ffmpeg-build /usr/share/vocalis-g1/ffmpeg-build-packages.txt /usr/share/vocalis-g1/ffmpeg-build-packages.txt
COPY --from=ffmpeg-build /usr/share/vocalis-g1/ffmpeg-configure-options.txt /usr/share/vocalis-g1/ffmpeg-configure-options.txt

# Install the LGPL/permissive FFmpeg codecs and retained audio-library closure;
# the Ubuntu FFmpeg package and its GPL codec closure remain excluded.
RUN --mount=type=bind,from=ffmpeg-debs,target=/ffmpeg-debs,readonly \
    python - <<'PY'
import csv
import glob
import hashlib
import os
import subprocess

lock_path = "/usr/share/vocalis-g1/ffmpeg-native.lock"
with open(lock_path, encoding="utf-8", newline="") as lock_file:
    rows = [row for row in csv.reader(lock_file, delimiter="\t") if row and not row[0].startswith("#")]

expected = {row[3] for row in rows}
artifacts = sorted(glob.glob("/ffmpeg-debs/*.deb"))
actual = {os.path.basename(path) for path in artifacts}
if actual != expected:
    raise SystemExit(f"audio runtime artifact set mismatch: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")

for package, version, architecture, filename, byte_count, digest in rows:
    path = f"/ffmpeg-debs/{filename}"
    if os.path.getsize(path) != int(byte_count):
        raise SystemExit(f"audio runtime artifact size mismatch: {filename}")
    hasher = hashlib.sha256()
    with open(path, "rb") as artifact:
        for block in iter(lambda: artifact.read(1024 * 1024), b""):
            hasher.update(block)
    if hasher.hexdigest() != digest:
        raise SystemExit(f"audio runtime artifact hash mismatch: {filename}")
    fields = subprocess.check_output(
        ["dpkg-deb", "-f", path, "Package", "Version", "Architecture"], text=True
    ).splitlines()
    values = [field.split(": ", 1)[1] for field in fields]
    if values != [package, version, architecture]:
        raise SystemExit(f"audio runtime package metadata mismatch: {filename}: {values}")

subprocess.run(["dpkg", "-i", *artifacts], check=True)
PY
RUN ldconfig \
 && ffmpeg -hide_banner -L 2>&1 | grep -F 'version 2.1 of the License, or (at your option) any later version' \
 && ffmpeg -hide_banner -buildconf 2>&1 | grep -F -- '--disable-gpl' \
 && ffmpeg -hide_banner -buildconf 2>&1 | grep -F -- '--disable-nonfree' \
 && ffmpeg -hide_banner -buildconf 2>&1 | grep -F -- '--disable-autodetect' \
 && ffmpeg -hide_banner -encoders 2>&1 | grep -F 'libmp3lame' \
 && ffmpeg -hide_banner -encoders 2>&1 | grep -F 'libopus' \
 && ! ffmpeg -hide_banner -encoders 2>&1 | grep -E 'libx264|libx265|libxvid' \
 && ffprobe -version | head -n 1

RUN python - <<'PY'
import json
import subprocess
import tempfile
from pathlib import Path

root = Path(tempfile.mkdtemp(prefix="ffmpeg-audio-smoke-"))
try:
    source = root / "tone.wav"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
         "sine=frequency=440:duration=0.4", "-c:a", "pcm_s16le", str(source)], check=True
    )
    cases = [
        ("flac", "flac", "flac"),
        ("mp3", "libmp3lame", "mp3"),
        ("opus", "libopus", "ogg"),
        ("m4a", "aac", "mp4"),
    ]
    for extension, codec, muxer in cases:
        output = root / f"tone.{extension}"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(source),
             "-c:a", codec, "-f", muxer, str(output)], check=True
        )
        probe = json.loads(subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name",
             "-of", "json", str(output)], text=True
        ))
        if not output.is_file() or not probe.get("streams"):
            raise SystemExit(f"FFmpeg did not produce a probeable {extension} audio file")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(output),
                        "-f", "null", "-"], check=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
         "sine=frequency=440:duration=1", "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
         "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0,"
         "aresample=22050,atrim=duration=0.5,loudnorm", "-f", "null", "-"], check=True
    )
finally:
    for item in root.iterdir():
        item.unlink()
    root.rmdir()
PY

# Verify the copied engine environments without rewriting them. A recursive
# chmod here would copy every file into a new layer and store each tens-of-GB
# environment twice; COPY already makes them root-owned, so the runtime user
# cannot write them as long as nothing is world-writable.
RUN set -eu; \
    export PYTHONDONTWRITEBYTECODE=1; \
    test -x /opt/python/3.12.15/bin/python3.12; \
    test -x /opt/python/bin/python3.11; \
    test -x /opt/dfn-venv/bin/python; \
    test -x /opt/vocalis/venvs/trim/bin/python; \
    test -x /opt/vocalis/venvs/enhance/bin/python; \
    test -x /opt/vocalis/venvs/voxcpm2/bin/python; \
    test -x /opt/vocalis/venvs/stems/bin/python; \
    test -x /opt/vocalis/venvs/leadvocal/bin/python; \
    test -x /opt/venvs/acestep/bin/python; \
    grep -F 'version = 3.11.17' /opt/dfn-venv/pyvenv.cfg; \
    /opt/python/3.12.15/bin/python3.12 -c 'import sys; assert sys.version_info[:3] == (3, 12, 15)'; \
    /opt/dfn-venv/bin/python -c 'import sys; assert sys.version_info[:3] == (3, 11, 17)'; \
    /opt/dfn-venv/bin/python -m pip check; \
    /opt/vocalis/venvs/trim/bin/python -m pip check; \
    /opt/vocalis/venvs/enhance/bin/python -m pip check; \
    /opt/vocalis/venvs/voxcpm2/bin/python -m pip check; \
    /opt/vocalis/venvs/stems/bin/python -m pip check; \
    /opt/vocalis/venvs/leadvocal/bin/python -m pip check; \
    /opt/venvs/acestep/bin/python -m pip check; \
    writable="$(find /opt/vocalis/venvs /opt/venvs/acestep /opt/acestep /opt/dfn-venv /opt/python/bin/python3.11 /opt/python/lib \
      ! -type l \( ! -user 0 -o -perm -0002 \) -print -quit)"; \
    test -z "${writable}" || { echo "engine runtime path is not image-owned read-only: ${writable}" >&2; exit 1; }

# October 10, 2026 (design section 10, "Whole-card memory and readings on NVIDIA, and on AMD
# satellites", Packaging). The NVIDIA profile asks the driver how much of a card is used in total
# through nvidia-ml-py (module pynvml); PyTorch's own free-memory number does not see other
# programs on Windows. The pinned wheel comes from the `nvml` build context (packaging/nvml, built by
# build_main_app.py), installed into the primary Python environment with no index, no dependencies
# and hash checking, so the build stays offline and the dependency image is not rebuilt. Its
# BSD-3-Clause license text goes with the other third-party notices. The AMD profile installs nothing:
# the main server reads AMD's own sensor, and NVML is consulted only on a CUDA build of PyTorch.
RUN --mount=type=bind,from=nvml,target=/nvml,readonly \
    set -eu; \
    if [ "${APP_PROFILE}" = "cuda" ]; then \
      "${APP_PRIMARY_PYTHON}" -m pip install --no-index --no-cache-dir --no-deps --require-hashes \
        --only-binary=:all: --find-links=/nvml -r /nvml/requirements.lock; \
      install -D -m 0644 /nvml/LICENSE-nvidia-ml-py.txt /usr/share/licenses/vocalis-g1/nvidia-ml-py-LICENSE.txt; \
      "${APP_PRIMARY_PYTHON}" -m pip show nvidia-ml-py | grep -F 'Version: 13.615.71'; \
    else \
      echo "nvidia-ml-py: not installed for profile ${APP_PROFILE}"; \
    fi

# Keep the code root image-owned and read-only. External roots are deliberately
# not created in the image so the encrypted bootstrap can require real mounts.
COPY --from=appsrc / /opt/vocalis/src/
# The server entrypoint imports `vocalis_server` by module name, and the stream
# loader resolves this shared module from /opt/vocalis/satellite.
COPY --from=vocalis-license /vocalis.py /opt/vocalis/vocalis.py
COPY --from=vocalis-license /satellite/vocalis_stream_core.py /opt/vocalis/satellite/vocalis_stream_core.py
COPY --from=vocalis-license /satellite/vocalis_satellite_protocol.py /opt/vocalis/satellite/vocalis_satellite_protocol.py
COPY --from=vocalis-license /satellite/vocalis_torch_backend.py /opt/vocalis/satellite/vocalis_torch_backend.py
# October 10, 2026 (design section 10, "Whole-card memory and readings"): the one owner of NVML
# handling (UUID mapping, per-field tolerance), read by the main server's whole-card reader.
COPY --from=vocalis-license /satellite/vocalis_satellite_gpustats.py /opt/vocalis/satellite/vocalis_satellite_gpustats.py
COPY --from=engine-scripts / /opt/vocalis/scripts/
COPY --from=nomi-extension / /opt/vocalis/nomi/chrome_extension/
COPY --from=st-extension / /opt/vocalis/sillytavern/extension/
# The Worldbook Editor's system prompt (a card file), read at run time from this fixed path
# (src/vocalis/web/wbedit.py CARD_PATH). Only the card ships; the baseline scripts beside it in
# the repository are test oracles.
COPY --from=wbedit-card /Section-Editor.json /opt/vocalis/reference/wbedit-baseline/prompts/Section-Editor.json
COPY --from=chatterbox-assets /manifest.json /usr/share/vocalis-g1/chatterbox-model-manifest.json
COPY --from=chatterbox-assets /NOTICE.md /usr/share/licenses/vocalis-g1/chatterbox-model-NOTICE.md
COPY --from=vocalis-license /LICENSE /usr/share/licenses/vocalis-g1/Vocalis-LICENSE
# The full texts of the GNU licenses that packaging/licenses/NOTICE.md cites for the libraries in this image:
# GPL-3.0 (the GCC runtime library copies in the Python wheels, and LGPL-3.0 incorporates it), LGPL-2.1 (soxr, the
# libsndfile build in the soundfile wheel, libquadmath, FFmpeg) and LGPL-3.0 (lameenc, frozendict). October 11, 2026:
# before this the image carried FFmpeg's LGPL text only. The `license-texts` context is packaging/licenses of the
# frozen source tree (main-app-build.json lists the three files as source inputs).
COPY --from=license-texts /GPL-3.0.txt /usr/share/licenses/vocalis-g1/GPL-3.0.txt
COPY --from=license-texts /LGPL-2.1.txt /usr/share/licenses/vocalis-g1/LGPL-2.1.txt
COPY --from=license-texts /LGPL-3.0.txt /usr/share/licenses/vocalis-g1/LGPL-3.0.txt

# Setup-time model acquisition (design section 5, "Model acquisition by setup"). The image is the single
# authority for which model files it needs: it carries the stdlib-only fetcher and the lock files it
# reads (same relative layout as packaging/models/, so the fetcher finds its locks beside itself;
# Chatterbox is read from the manifest copied above), plus each model's NOTICE/licence text.
# setup.sh runs it as a one-shot container with this interpreter, which both profiles carry
# (checked above and below). These sit in the small top layers, after the large engine COPYs, so an
# edit to the fetcher or a lock rebuilds only these layers. The RUN fails the build early if that
# interpreter lacks TLS support, which every download depends on.
COPY --from=model-acquisition /code/ /usr/share/vocalis-g1/models/
COPY --from=model-acquisition /notices/ /usr/share/licenses/vocalis-g1/models/
RUN /opt/python/3.12.15/bin/python3.12 -c 'import fcntl, ssl, urllib.request; assert ssl.OPENSSL_VERSION'

# October 10, 2026 (design section 10, "Whole-card memory and readings"). Fail the build early if the
# readout module the main server loads from /opt/vocalis/satellite does not import in the primary
# environment (both profiles), and, for the NVIDIA profile, if the pynvml module the wheel installs
# does not import there. Importing pynvml does not need a driver; nvmlInit() is not called at build.
RUN set -eu; \
    export PYTHONDONTWRITEBYTECODE=1; \
    "${APP_PRIMARY_PYTHON}" -c 'import sys; sys.path.insert(0, "/opt/vocalis/satellite"); import vocalis_satellite_gpustats; print("gpustats import: " + vocalis_satellite_gpustats.__file__)'; \
    if [ "${APP_PROFILE}" = "cuda" ]; then \
      "${APP_PRIMARY_PYTHON}" -c 'import pynvml; print("pynvml import: " + pynvml.__file__)'; \
    fi

# local-model-root.patch makes only the ACE-Step paths that read ACESTEP_CHECKPOINTS_DIR use the
# mounted root; eight others (lazy LM init, reinitialize, sample/format helpers, LM switching, the
# pipeline) still join <source>/checkpoints. That directory does not exist in the image, so every
# Think/CoT render failed with status 2 and the patched downloader refused to fetch (M1, AMD test host).
# Point the default at the model mount; drop this when a rebuilt engine patches every site.
RUN chmod -R a-w /opt/vocalis/src /opt/vocalis/vocalis.py /opt/vocalis/satellite \
      /opt/vocalis/scripts /opt/vocalis/nomi /opt/vocalis/sillytavern /opt/vocalis/reference \
 && chmod a-w /opt/vocalis /opt/vocalis/venvs \
 && mkdir -p /home/vocalis \
 && chown "${VOCALIS_UID}:${VOCALIS_GID}" /home/vocalis \
 && ln -s /models/vocalis/acestep /opt/acestep/checkpoints

# ACE-Step's backend falls back to its 0.6B 5Hz LM when ACESTEP_LM_MODEL_PATH is unset, and the
# package ships only the 1.7B LM (packaging/models/acestep/model-file-lock.json). Without this,
# every render with Think/CoT on (the UI default) failed instantly with status 2 (M1, AMD test host).
#
# October 10, 2026 (in-place switch design, items 4 and 13). One ENV serves the CUDA and ROCm app
# images: packaging/main-app-build.json names this file as the only app recipe and APP_PROFILE only
# selects the base, so there is no second ENV block to keep in step.
#  - VOCALIS_ACESTEP_STAGE_DIR: Vocalis (runtime/acestage.py) staged ACE reference/source audio under
#    its own default /ai-output/acestep-tmp while the ACE child (runtime/acestep.py) reads
#    /work/vocalis/acestep, so the backend never saw the staged file. Both now read this variable.
#  - The Docker-only runtime caches (HF, torch, XDG) live under /work/vocalis/runtime-cache, not in
#    VOCALIS_CACHE_DIR, which an adopted standalone install shares with legacy Vocalis (rule 2:
#    nothing Docker-only in the user's cache). The folder is not made here: /work/vocalis is a mount,
#    and the libraries create their own subfolders on first write as the service user. NUMBA_CACHE_DIR
#    and MPLCONFIGDIR are not set in this image (only the separate trim engine image sets them, and
#    that ENV does not reach here); numba and matplotlib fall back to XDG_CACHE_HOME.
#
# October 11, 2026 (Stems and Lead Vocal model files, licensing hold lifted). Setup downloads their
# model files (packaging/models/stems and packaging/models/leadvocal locks); nothing is shipped.
#  - VOCALIS_STEMS_MODEL_ROOT: where setup puts the HTDemucs weights (hub/checkpoints/<file> below it).
#    The application gives the Demucs child this path as its TORCH_HOME (stems.demucs_child_env), so
#    torch.hub finds the file there and has nothing to download. The global TORCH_HOME above is not
#    changed and no other child sees this value as TORCH_HOME.
#  - LEADVOCAL_MODELS (already set below) is both the directory the Lead Vocal feature reads and the
#    destination of its lock; the fetcher reads it from here.
ENV HOME=/home/vocalis \
    USER=vocalis \
    LOGNAME=vocalis \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VOCALIS_REQUIRE_VAULT=1 \
    VOCALIS_DATA_DIR=/data/vocalis \
    VOCALIS_CACHE_DIR=/cache/vocalis \
    VOCALIS_LOG_DIR=/logs \
    VOCALIS_SCRATCH_DIR=/work/vocalis/scratch \
    VOCALIS_BULK_DIR=/work/vocalis/bulk \
    VOCALIS_ACESTEP_STAGE_DIR=/work/vocalis/acestep \
    VOCALIS_CHATTERBOX_MODEL_DIR=/models/vocalis/chatterbox/5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18 \
    LEADVOCAL_MODELS=/models/vocalis/leadvocal \
    VOCALIS_VOXCPM_HF_HOME=/models/vocalis/voxcpm \
    HF_HOME=/work/vocalis/runtime-cache/huggingface \
    HUGGINGFACE_HUB_CACHE=/work/vocalis/runtime-cache/huggingface/hub \
    TRANSFORMERS_CACHE=/work/vocalis/runtime-cache/transformers \
    TORCH_HOME=/work/vocalis/runtime-cache/torch \
    XDG_CACHE_HOME=/work/vocalis/runtime-cache/xdg \
    VOCALIS_VOXCPM_VENV=/opt/vocalis/venvs/voxcpm2 \
    VOCALIS_VOXCPM_MODEL=/models/vocalis/voxcpm2/32279effe8c19989596f05d353d1447f51d9e915 \
    VOCALIS_ENHANCE_VENV=/opt/vocalis/venvs/enhance \
    VOCALIS_ENHANCE_MODEL_DIR=/models/vocalis/enhance/f35e879924e339228db2e9752185a21ef8ffeb3e/enhancer_stage2 \
    VOCALIS_DFN_VENV=/opt/dfn-venv \
    VOCALIS_DFN_MODEL_ROOT=/models/vocalis/cleanup/dfn3 \
    VOCALIS_TRIM_VENV=/opt/vocalis/venvs/trim \
    VOCALIS_TRIM_MODEL_ROOT=/models/vocalis/trim \
    VOCALIS_STEMS_VENV=/opt/vocalis/venvs/stems \
    VOCALIS_STEMS_MODEL_ROOT=/models/vocalis/stems \
    LEADVOCAL_VENV=/opt/vocalis/venvs/leadvocal \
    VOCALIS_ACESTEP_PYTHON=/opt/venvs/acestep/bin/python \
    VOCALIS_ACESTEP_SOURCE=/opt/acestep \
    VOCALIS_ACESTEP_MODEL_DIR=/models/vocalis/acestep \
    ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-1.7B \
    TMPDIR=/work/vocalis/scratch

USER ${VOCALIS_UID}:${VOCALIS_GID}
EXPOSE 7870
ENTRYPOINT ["python", "vocalis.py", "--host", "0.0.0.0", "--port", "7870"]
