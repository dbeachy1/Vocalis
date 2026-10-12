# syntax=docker/dockerfile:1.6
# Build the retained LeadVocal environment on the selected clean app base.
ARG BASE_IMAGE

FROM ${BASE_IMAGE} AS leadvocal-engine
ARG BASE_IMAGE_ID
ARG PROFILE
ARG LOCK_SHA256
ARG SOURCE_LOCK_SHA256
ARG DWT_LOCK_SHA256
ARG NATIVE_LOCK_SHA256
ARG NATIVE_SOURCE_LOCK_SHA256

USER root
WORKDIR /tmp/leadvocal-build
COPY packaging/leadvocal/requirements.cuda.lock /tmp/requirements.cuda.lock
COPY packaging/leadvocal/requirements.rocm.lock /tmp/requirements.rocm.lock
COPY packaging/leadvocal/audio-separator-source.lock.json /tmp/audio-separator-source.lock.json
COPY packaging/leadvocal/audio-separator-source-files.json /tmp/audio-separator-source-files.json
COPY packaging/leadvocal/audio-separator.patch /tmp/audio-separator.patch
COPY packaging/acestep/dwt1d-distribution.lock.json /tmp/dwt1d-distribution.lock.json
COPY packaging/acestep/dwt1d-source-artifact.lock.json /tmp/dwt1d-source-artifact.lock.json
COPY packaging/acestep/dwt1d-derivation.md /tmp/dwt1d-derivation.md
COPY packaging/acestep/dwt1d-source/pytorch_wavelets/LICENSE /tmp/dwt1d-LICENSE
COPY packaging/licenses/copy_locked_wheel_notices.py /tmp/copy_locked_wheel_notices.py
COPY packaging/main-cuda/ffmpeg-native.lock /usr/share/licenses/vocalis/leadvocal/native/ffmpeg-native.lock
COPY packaging/licenses/apt-runtime-source-artifacts.json /usr/share/licenses/vocalis/leadvocal/native/apt-runtime-source-artifacts.json
LABEL org.vocalis.leadvocal.base-image-id=${BASE_IMAGE_ID} \
      org.vocalis.leadvocal.profile=${PROFILE} \
      org.vocalis.leadvocal.requirements-lock-sha256=${LOCK_SHA256} \
      org.vocalis.leadvocal.source-lock-sha256=${SOURCE_LOCK_SHA256} \
      org.vocalis.leadvocal.dwt-lock-sha256=${DWT_LOCK_SHA256} \
      org.vocalis.leadvocal.native-lock-sha256=${NATIVE_LOCK_SHA256} \
      org.vocalis.leadvocal.native-source-lock-sha256=${NATIVE_SOURCE_LOCK_SHA256}

RUN --network=none \
    --mount=type=bind,from=wheelhouse,target=/wheelhouse,readonly \
    --mount=type=bind,from=ffmpeg-debs,target=/ffmpeg-debs,readonly \
    set -eu; \
    case "${PROFILE}" in \
      cuda) lock=/tmp/requirements.cuda.lock ;; \
      rocm) lock=/tmp/requirements.rocm.lock ;; \
      *) echo "PROFILE must be cuda or rocm" >&2; exit 2 ;; \
    esac; \
    printf '%s  %s\n' "${LOCK_SHA256}" "$lock" | sha256sum -c -; \
    printf '%s  %s\n' "${SOURCE_LOCK_SHA256}" /tmp/audio-separator-source.lock.json | sha256sum -c -; \
    printf '%s  %s\n' "${DWT_LOCK_SHA256}" /tmp/dwt1d-distribution.lock.json | sha256sum -c -; \
    printf '%s  %s\n' "${NATIVE_SOURCE_LOCK_SHA256}" /usr/share/licenses/vocalis/leadvocal/native/apt-runtime-source-artifacts.json | sha256sum -c -; \
    printf '%s  %s\n' "${NATIVE_LOCK_SHA256}" /usr/share/licenses/vocalis/leadvocal/native/ffmpeg-native.lock | sha256sum -c -; \
    /opt/python/3.12.15/bin/python3.12 - <<'PY'
import hashlib
import json
from pathlib import Path

lock = Path("/usr/share/licenses/vocalis/leadvocal/native/ffmpeg-native.lock")
rows = [line.rstrip("\n").split("\t") for line in lock.read_text().splitlines()
        if line and not line.startswith("#")]
rows = [row for row in rows if row[0] == "libsamplerate0"]
assert len(rows) == 1, f"expected one libsamplerate0 runtime lock entry, found {len(rows)}"
package, version, arch, filename, size, expected = rows[0]
assert version == "0.2.2-4build2" and arch == "amd64"
deb = Path("/ffmpeg-debs") / filename
assert deb.is_file() and not deb.is_symlink()
assert deb.stat().st_size == int(size)
actual = hashlib.sha256(deb.read_bytes()).hexdigest()
assert actual == expected, f"libsamplerate0 artifact hash mismatch: {actual}"
PY
RUN --network=none \
    --mount=type=bind,from=wheelhouse,target=/wheelhouse,readonly \
    --mount=type=bind,from=ffmpeg-debs,target=/ffmpeg-debs,readonly \
    set -eu; \
    case "${PROFILE}" in \
      cuda) lock=/tmp/requirements.cuda.lock ;; \
      rocm) lock=/tmp/requirements.rocm.lock ;; \
      *) echo "PROFILE must be cuda or rocm" >&2; exit 2 ;; \
    esac; \
    deb="$(awk -F '\t' '$1 == "libsamplerate0" { print $4 }' /usr/share/licenses/vocalis/leadvocal/native/ffmpeg-native.lock)"; \
    test -n "$deb"; \
    dpkg -i "/ffmpeg-debs/$deb"; \
    mkdir -p /opt/vocalis/venvs; \
    /opt/python/3.12.15/bin/python3.12 -m venv /opt/vocalis/venvs/leadvocal; \
    /opt/vocalis/venvs/leadvocal/bin/python -m pip install --disable-pip-version-check --no-compile --no-index --find-links=/wheelhouse --require-hashes --no-cache-dir -r "$lock"
RUN --network=none --mount=type=bind,from=wheelhouse,target=/wheelhouse,readonly \
    set -eu; \
    case "${PROFILE}" in \
      cuda) lock=/tmp/requirements.cuda.lock ;; \
      rocm) lock=/tmp/requirements.rocm.lock ;; \
      *) echo "PROFILE must be cuda or rocm" >&2; exit 2 ;; \
    esac; \
    /opt/python/3.12.15/bin/python3.12 -c 'import hashlib,json; from pathlib import Path; data=json.loads(Path("/tmp/dwt1d-distribution.lock.json").read_text()); path=Path("/wheelhouse")/data["distribution"]["filename"]; assert path.is_file() and path.stat().st_size==data["distribution"]["bytes"]; assert hashlib.sha256(path.read_bytes()).hexdigest()==data["distribution"]["sha256"]'; \
    /opt/vocalis/venvs/leadvocal/bin/python -m pip install --disable-pip-version-check --no-compile --no-index --no-deps --no-cache-dir \
      "/wheelhouse/pytorch_wavelets-1.3.0+vocalis.dwt1d.1-py3-none-any.whl"; \
    /opt/vocalis/venvs/leadvocal/bin/python -m pip check; \
    /opt/python/3.12.15/bin/python3.12 /tmp/copy_locked_wheel_notices.py --lock "$lock" --wheelhouse /wheelhouse --out /usr/share/licenses/vocalis/leadvocal/wheels; \
    mkdir -p /usr/share/licenses/vocalis/leadvocal/source/audio-separator /usr/share/licenses/vocalis/leadvocal/source/dwt1d; \
    cp /tmp/audio-separator-source.lock.json /tmp/audio-separator-source-files.json /tmp/audio-separator.patch /usr/share/licenses/vocalis/leadvocal/source/audio-separator/; \
    cp /tmp/dwt1d-distribution.lock.json /tmp/dwt1d-source-artifact.lock.json /tmp/dwt1d-derivation.md /tmp/dwt1d-LICENSE /usr/share/licenses/vocalis/leadvocal/source/dwt1d/; \
    /opt/vocalis/venvs/leadvocal/bin/python -m pip check
ENV VOCALIS_LEADVOCAL_VENV=/opt/vocalis/venvs/leadvocal \
    VOCALIS_ENGINE_PROFILE=${PROFILE} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN --network=none /opt/vocalis/venvs/leadvocal/bin/python - <<'PY'
import importlib
import importlib.metadata
import json
import sys
import tempfile

import numpy as np
import samplerate
import torch
import torchaudio
import onnxruntime as ort
from audio_separator.separator import Separator
from pytorch_wavelets import DWT1DForward, DWT1DInverse

assert sys.version_info[:3] == (3, 12, 15)
assert importlib.metadata.version("audio-separator") == "0.44.5+vocalis.2"
assert importlib.metadata.version("PyWavelets") == "1.9.0"
assert importlib.metadata.version("pytorch-wavelets") == "1.3.0+vocalis.dwt1d.1"
assert torch.__version__.startswith("2.10.0+")
assert torchaudio.__version__ == torch.__version__

# These are the three architectures selected by the retained LeadVocal profile; import them
# without loading model files or invoking audio-separator's model downloader.
architectures = {
    "MDX": "mdx_separator",
    "VR": "vr_separator",
    "MDXC": "mdxc_separator",
}
for module in architectures.values():
    importlib.import_module(f"audio_separator.separator.architectures.{module}")
with tempfile.TemporaryDirectory(prefix="leadvocal-smoke-") as scratch:
    separator = Separator(info_only=True, model_file_dir=f"{scratch}/models", output_dir=f"{scratch}/output")
    assert separator.model_file_dir == f"{scratch}/models"

# Save one result the way every separation does. October 11, 2026: the first real Lead Vocal runs
# got through the model and then failed here, because this step calls librosa with an argument
# librosa 1.0 no longer accepts. Importing the modules, which was all this check did, cannot see that.
import logging

import soundfile as sf
from audio_separator.separator.common_separator import CommonSeparator

with tempfile.TemporaryDirectory(prefix="leadvocal-save-") as scratch:
    rate = 44100
    tone = 0.5 * np.sin(2.0 * np.pi * 440.0 * np.arange(rate, dtype=np.float32) / rate)
    stereo = np.stack([tone, tone], axis=1)
    sf.write(f"{scratch}/source.wav", stereo, rate, subtype="PCM_16")
    saver = CommonSeparator({
        "logger": logging.getLogger("leadvocal-smoke"), "log_level": logging.INFO,
        "torch_device": None, "torch_device_cpu": None, "torch_device_mps": None,
        "onnx_execution_provider": ["CPUExecutionProvider"], "model_name": "smoke",
        "model_path": "smoke.pth", "model_data": {}, "output_dir": f"{scratch}/out",
        "output_format": "WAV", "output_bitrate": None, "normalization_threshold": 0.9,
        "amplification_threshold": 0.0, "enable_denoise": False, "output_single_stem": None,
        # This component image has no ffmpeg program (the main image supplies it), so the write
        # itself goes through soundfile here. The librosa call that broke runs before that choice.
        "invert_using_spec": False, "sample_rate": rate, "use_soundfile": True,
    })
    saver.audio_file_path = f"{scratch}/source.wav"
    saver.input_bit_depth = 16
    saver.write_audio("stem.wav", stereo.copy())
    saved = sf.info(f"{scratch}/out/stem.wav")
    assert (saved.frames, saved.samplerate, saved.channels) == (rate, rate, 2), saved
    saved_frames = int(saved.frames)

# Exercise the Linux libsamplerate loader with a short synthetic signal.
signal = np.sin(np.linspace(0.0, 2.0 * np.pi, 4096, dtype=np.float32))
resampled = samplerate.resample(signal, 0.5, "sinc_best")
assert resampled.size > 0 and np.isfinite(resampled).all()

# Confirm the isolated DWT distribution exposes its retained transforms.
assert DWT1DForward is not None and DWT1DInverse is not None
print(json.dumps({
    "profile": __import__("os").environ["VOCALIS_ENGINE_PROFILE"],
    "python": sys.version.split()[0],
    "torch": torch.__version__,
    "torchaudio": torchaudio.__version__,
    "onnxruntime": ort.__version__,
    "audio_separator": importlib.metadata.version("audio-separator"),
    "pytorch_wavelets": importlib.metadata.version("pytorch-wavelets"),
    "pywavelets": importlib.metadata.version("PyWavelets"),
    "architecture_imports": sorted(architectures),
    "model_files_loaded": False,
    "saved_result_frames": saved_frames,
    "samplerate_output_samples": int(resampled.size),
}))
PY
USER 1000:1000
