# syntax=docker/dockerfile:1.6
# Build context is packaging/main-cuda only; this image contains the proven
# Python 3.12 main CUDA dependency graph, not Vocalis application code/startup.
FROM --platform=linux/amd64 ubuntu@sha256:88a381d5b5eeb2b35d3ad70925a362c37ce569daf43ede89ff818ec20e4d3794 AS native
ARG DEBIAN_FRONTEND=noninteractive

# Exact runtime packages from the passing Ubuntu 26.04.1 interpreter probe.
# Version drift fails closed; do not relax these pins to make a build pass.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      ca-certificates=20260601~26.04.1 \
      libssl3t64=3.5.5-1ubuntu3.7 \
      libffi8=3.5.2-4 \
      libbz2-1.0=1.0.8-6ubuntu0.1 \
      liblzma5=5.8.3-1 \
      zlib1g=1:1.3.dfsg+really1.3.1-1ubuntu3.1 \
      libsqlite3-0=3.46.1-9ubuntu0.3 \
 && rm -rf /var/lib/apt/lists/*

FROM native AS python-runtime
# Official Astral standalone CPython release asset; checksum is enforced by BuildKit.
ADD --checksum=sha256:731af898886c5f821890dc901eca3c651cca8e51fa7308c159d12a1194aeac91 \
    https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz \
    /tmp/cpython312.tar.gz
RUN mkdir -p /opt/python/3.12.15 \
 && tar -xzf /tmp/cpython312.tar.gz -C /opt/python/3.12.15 --strip-components=1 \
 && rm /tmp/cpython312.tar.gz \
 && /opt/python/3.12.15/bin/python3.12 -m venv /opt/venv/3.12 \
 && /opt/venv/3.12/bin/python -c "import pip; assert pip.__version__ == '25.0.1', pip.__version__"

ENV PATH=/opt/venv/3.12/bin:/opt/python/3.12.15/bin:${PATH}

FROM python-runtime AS dependency-build
COPY requirements.lock /tmp/requirements.lock
RUN --mount=type=bind,from=basewheels,target=/basewheels,readonly \
    --mount=type=bind,from=mainwheels,target=/mainwheels,readonly \
    PIP_CONFIG_FILE=/dev/null PIP_DISABLE_PIP_VERSION_CHECK=1 \
      /opt/venv/3.12/bin/python -m pip install --no-index --no-cache-dir --no-deps --require-hashes --only-binary=:all: \
        --find-links=/basewheels \
        --find-links=/mainwheels \
        -r /tmp/requirements.lock \
 && /opt/venv/3.12/bin/python -m pip check

FROM native AS runtime
COPY --from=python-runtime /opt/python/3.12.15 /opt/python/3.12.15
COPY --from=dependency-build /opt/venv/3.12 /opt/venv/3.12
COPY requirements.lock /usr/share/vocalis-g1/requirements.lock
COPY --from=chatterbox /NOTICE.md /usr/share/licenses/vocalis-g1/chatterbox/NOTICE.md
COPY --from=chatterbox /artifact-manifest.json /usr/share/licenses/vocalis-g1/chatterbox/artifact-manifest.json
ENV PATH=/opt/venv/3.12/bin:/opt/python/3.12.15/bin:${PATH} VOCALIS_REQUIRE_VAULT=1
