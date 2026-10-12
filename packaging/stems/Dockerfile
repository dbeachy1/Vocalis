# syntax=docker/dockerfile:1.6
# Build the retained Demucs environment from an explicit clean application base.
ARG BASE_IMAGE=scratch

FROM ${BASE_IMAGE} AS demucs-wheel
ARG BASE_IMAGE_ID
ARG BUILD_LOCK_SHA256
ARG SOURCE_LOCK_SHA256

USER root
WORKDIR /tmp/stems-build
COPY packaging/stems/build-requirements.lock /tmp/build-requirements.lock
COPY packaging/stems/source-artifacts.lock.json /tmp/source-artifacts.lock.json
COPY --from=demucs-source /demucs-4.0.1.tar.gz /tmp/demucs-4.0.1.tar.gz
COPY --from=stems-source /lameenc-v1.8.4.tar.gz /tmp/lameenc-v1.8.4.tar.gz
COPY --from=stems-source /lame-3.100.tar.gz /tmp/lame-3.100.tar.gz
LABEL org.vocalis.stems.base-image-id=${BASE_IMAGE_ID} \
      org.vocalis.stems.source-lock-sha256=${SOURCE_LOCK_SHA256} \
      org.vocalis.stems.build-lock-sha256=${BUILD_LOCK_SHA256}

RUN --mount=type=bind,from=common-wheelhouse,target=/wheelhouse,readonly \
    set -eu; \
    test "$(uname -m)" = "x86_64"; \
    test -x /opt/python/3.12.15/bin/python3.12; \
    /opt/python/3.12.15/bin/python3.12 -c 'import sys; assert sys.version_info[:3] == (3, 12, 15)'; \
    printf '%s  %s\n' "${BUILD_LOCK_SHA256}" /tmp/build-requirements.lock | sha256sum -c -; \
    printf '%s  %s\n' "${SOURCE_LOCK_SHA256}" /tmp/source-artifacts.lock.json | sha256sum -c -; \
    /opt/python/3.12.15/bin/python3.12 - <<'PY'
import hashlib
import json
import tarfile
from pathlib import Path

lock = json.loads(Path("/tmp/source-artifacts.lock.json").read_text())
archive = Path("/tmp/demucs-4.0.1.tar.gz")
entry = lock["runtimeGraph"]["demucs"]
assert archive.stat().st_size == entry["bytes"]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == entry["sha256"]
with tarfile.open(archive, "r:gz") as source:
    members = source.getmembers()
    for member in members:
        path = Path(member.name)
        if path.is_absolute() or ".." in path.parts or path.parts[0] != "demucs-4.0.1":
            raise SystemExit(f"unsafe or unexpected Demucs archive member: {member.name}")
    source.extractall("/tmp/demucs-src", filter="data")
PY
RUN --mount=type=bind,from=common-wheelhouse,target=/wheelhouse,readonly \
    set -eu; \
    /opt/python/3.12.15/bin/python3.12 -m venv /tmp/demucs-build-venv; \
    /tmp/demucs-build-venv/bin/python -m pip install --disable-pip-version-check --no-compile --no-index --find-links=/wheelhouse --require-hashes --no-cache-dir -r /tmp/build-requirements.lock; \
    mkdir -p /tmp/demucs-wheel; \
    /tmp/demucs-build-venv/bin/python -m pip wheel --disable-pip-version-check --no-deps --no-build-isolation --no-index --wheel-dir /tmp/demucs-wheel /tmp/demucs-src/demucs-4.0.1; \
    test -f /tmp/demucs-wheel/demucs-4.0.1-py3-none-any.whl; \
    mkdir -p /tmp/stems-source-offer; \
    cp /tmp/demucs-4.0.1.tar.gz /tmp/lameenc-v1.8.4.tar.gz /tmp/lame-3.100.tar.gz /tmp/stems-source-offer/; \
    tar -xOf /tmp/demucs-4.0.1.tar.gz demucs-4.0.1/LICENSE > /tmp/stems-source-offer/DEMucs-MIT-LICENSE.txt; \
    tar -xOf /tmp/lame-3.100.tar.gz lame-3.100/COPYING > /tmp/stems-source-offer/LAME-COPYING-LGPL-2.0.txt; \
    tar -xOf /tmp/lame-3.100.tar.gz lame-3.100/LICENSE > /tmp/stems-source-offer/LAME-LICENSE.txt; \
    mkdir -p /tmp/lameenc-src; \
    tar -xzf /tmp/lameenc-v1.8.4.tar.gz -C /tmp/lameenc-src; \
    cp /tmp/lameenc-src/lameenc-1.8.4/LICENSE /tmp/stems-source-offer/lameenc-LICENSE-LGPL-3.0-or-later.txt

FROM ${BASE_IMAGE} AS stems-engine
ARG BASE_IMAGE_ID
ARG PROFILE
ARG LOCK_SHA256
ARG SOURCE_LOCK_SHA256
ARG BUILD_LOCK_SHA256

USER root
WORKDIR /tmp/stems-engine
COPY packaging/stems/requirements.cuda.lock /tmp/requirements.cuda.lock
COPY packaging/stems/requirements.rocm.lock /tmp/requirements.rocm.lock
COPY packaging/stems/source-artifacts.lock.json /tmp/source-artifacts.lock.json
COPY packaging/licenses/copy_locked_wheel_notices.py /tmp/copy_locked_wheel_notices.py
COPY --from=demucs-wheel /tmp/demucs-wheel/demucs-4.0.1-py3-none-any.whl /tmp/demucs-4.0.1-py3-none-any.whl
COPY --from=demucs-wheel /tmp/stems-source-offer /usr/share/licenses/vocalis/stems/source
LABEL org.vocalis.stems.base-image-id=${BASE_IMAGE_ID} \
      org.vocalis.stems.profile=${PROFILE} \
      org.vocalis.stems.requirements-lock-sha256=${LOCK_SHA256} \
      org.vocalis.stems.source-lock-sha256=${SOURCE_LOCK_SHA256} \
      org.vocalis.stems.build-lock-sha256=${BUILD_LOCK_SHA256}

RUN --mount=type=bind,from=common-wheelhouse,target=/common-wheelhouse,readonly \
    --mount=type=bind,from=vendor-wheelhouse,target=/vendor-wheelhouse,readonly \
    --mount=type=bind,from=locked-wheel-reuse,target=/locked-wheel-reuse,readonly \
    --mount=type=bind,from=rocm-notices,target=/rocm-notices,readonly \
    set -eu; \
    case "${PROFILE}" in \
      cuda) lock=/tmp/requirements.cuda.lock ;; \
      rocm) lock=/tmp/requirements.rocm.lock ;; \
      *) echo "PROFILE must be cuda or rocm" >&2; exit 2 ;; \
    esac; \
    printf '%s  %s\n' "${LOCK_SHA256}" "$lock" | sha256sum -c -; \
    printf '%s  %s\n' "${SOURCE_LOCK_SHA256}" /tmp/source-artifacts.lock.json | sha256sum -c -; \
    mkdir -p /opt/vocalis/venvs; \
    /opt/python/3.12.15/bin/python3.12 -m venv /opt/vocalis/venvs/stems; \
    /opt/vocalis/venvs/stems/bin/python -m pip install --disable-pip-version-check --no-compile --no-index --find-links=/common-wheelhouse --find-links=/vendor-wheelhouse --find-links=/locked-wheel-reuse --require-hashes --no-cache-dir -r "$lock"; \
    /opt/vocalis/venvs/stems/bin/python -m pip install --disable-pip-version-check --no-compile --no-index --no-deps /tmp/demucs-4.0.1-py3-none-any.whl; \
    /opt/vocalis/venvs/stems/bin/python -m pip check; \
    /opt/python/3.12.15/bin/python3.12 /tmp/copy_locked_wheel_notices.py --lock "$lock" --wheelhouse /common-wheelhouse --wheelhouse /vendor-wheelhouse --wheelhouse /locked-wheel-reuse --out /usr/share/licenses/vocalis/stems/wheels; \
    if [ "$PROFILE" = rocm ]; then \
      mkdir -p /usr/share/licenses/vocalis/stems/rocm; \
      cp -a /rocm-notices/rocm/. /usr/share/licenses/vocalis/stems/rocm/; \
      cp /rocm-notices/rocm-notice-artifacts.json /usr/share/licenses/vocalis/stems/rocm-notice-artifacts.json; \
    fi
ENV VOCALIS_ENGINE_PROFILE=${PROFILE}
RUN /opt/vocalis/venvs/stems/bin/python - <<'PY'
import importlib.metadata
import os
import json
import subprocess
import sys
import torch
import torchaudio
import demucs
import lameenc

assert sys.version_info[:3] == (3, 12, 15)
assert demucs.__version__ == "4.0.1"
assert torch.__version__.startswith("2.10.0+")
assert torchaudio.__version__ == torch.__version__
cli = subprocess.run([sys.executable, "-m", "demucs", "--help"],
                     check=True, capture_output=True, text=True)
assert "usage:" in cli.stdout.lower()
encoder = lameenc.Encoder()
encoder.set_in_sample_rate(44100)
encoder.set_channels(2)
encoded = encoder.encode(bytes(4410 * 2 * 2)) + encoder.flush()
assert encoded
print(json.dumps({"profile": os.environ["VOCALIS_ENGINE_PROFILE"], "torch": torch.__version__,
                  "torchaudio": torchaudio.__version__, "demucs": demucs.__version__,
                  "demucs_cli": "imported", "lameenc_mp3_bytes": len(encoded),
                  "torch_cuda_available": torch.cuda.is_available(),
                  "installed": sorted(d.metadata["Name"] for d in importlib.metadata.distributions())}))
PY
ENV VOCALIS_STEMS_VENV=/opt/vocalis/venvs/stems \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER 1000:1000
