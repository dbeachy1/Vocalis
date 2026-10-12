# Fail closed if a build forgets to supply a verified application base.
ARG BASE_IMAGE=scratch

FROM ${BASE_IMAGE} AS trim-builder
ARG BASE_IMAGE_ID
ARG LOCK_SHA256
ARG PANN_PATCH_SHA256
ARG APPLY_HELPER_SHA256
USER root
ENV HOME=/tmp TMPDIR=/tmp PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /opt/vocalis/trim-build
COPY .codex/packaging-probes/trim-cpu-resolution-20261008/proof-image-context/wheelhouse/ /tmp/trim-wheelhouse/
COPY .codex/packaging-probes/trim-cpu-resolution-20261008/proof-image-context/wheelhouse.sha256 /tmp/wheelhouse.sha256
COPY packaging/trim/requirements.cpu.lock /tmp/requirements.cpu.lock
COPY packaging/trim/local-inputs.patch /tmp/panns-local-inputs.patch
COPY packaging/trim/apply_local_inputs.py /tmp/apply_local_inputs.py
LABEL org.vocalis.trim.base-image-id=${BASE_IMAGE_ID} \
      org.vocalis.trim.requirements-lock-sha256=${LOCK_SHA256} \
      org.vocalis.trim.panns-local-inputs-patch-sha256=${PANN_PATCH_SHA256} \
      org.vocalis.trim.apply-helper-sha256=${APPLY_HELPER_SHA256}
RUN test "$(uname -m)" = "x86_64" \
 && test -x /opt/python/3.12.15/bin/python3.12 \
 && /opt/python/3.12.15/bin/python3.12 -c "import sys; assert sys.version_info[:3] == (3, 12, 15)" \
 && echo "${LOCK_SHA256}  /tmp/requirements.cpu.lock" | sha256sum -c - \
 && echo "${PANN_PATCH_SHA256}  /tmp/panns-local-inputs.patch" | sha256sum -c - \
 && echo "${APPLY_HELPER_SHA256}  /tmp/apply_local_inputs.py" | sha256sum -c - \
 && cd /tmp/trim-wheelhouse && sha256sum -c /tmp/wheelhouse.sha256 \
 && /opt/python/3.12.15/bin/python3.12 -m venv /opt/vocalis/venvs/trim \
 && /opt/vocalis/venvs/trim/bin/python -m pip install --disable-pip-version-check --no-compile --no-index --find-links=/tmp/trim-wheelhouse --require-hashes --no-cache-dir -r /tmp/requirements.cpu.lock \
 && /opt/vocalis/venvs/trim/bin/python -m pip check \
 && /opt/vocalis/venvs/trim/bin/python /tmp/apply_local_inputs.py /opt/vocalis/venvs/trim/lib/python3.12/site-packages/panns_inference \
 && test ! -e /opt/vocalis/venvs/trim/lib/python3.12/site-packages/panns_inference/__pycache__/config.cpython-312.pyc \
 && test ! -e /opt/vocalis/venvs/trim/lib/python3.12/site-packages/panns_inference/__pycache__/inference.cpython-312.pyc

FROM ${BASE_IMAGE} AS trim-runtime
ARG BASE_IMAGE_ID
ARG LOCK_SHA256
ARG PANN_PATCH_SHA256
ARG APPLY_HELPER_SHA256
ARG SCORER_SHA256
LABEL org.vocalis.trim.base-image-id=${BASE_IMAGE_ID} \
      org.vocalis.trim.requirements-lock-sha256=${LOCK_SHA256} \
      org.vocalis.trim.panns-local-inputs-patch-sha256=${PANN_PATCH_SHA256} \
      org.vocalis.trim.apply-helper-sha256=${APPLY_HELPER_SHA256} \
      org.vocalis.trim.scorer-source-sha256=${SCORER_SHA256}
USER root
COPY --from=trim-builder /opt/vocalis/venvs/trim /opt/vocalis/venvs/trim
COPY source/vocalis/scripts/cleanup/trim_scores.py /opt/vocalis/scripts/cleanup/trim_scores.py
COPY .codex/packaging-probes/trim-cpu-resolution-20261008/proof-image-context/notices/ /usr/share/licenses/vocalis/trim/notices/
COPY .codex/packaging-probes/panns-runtime-20261008/panns-inference-0.1.1.tar.gz /usr/share/licenses/vocalis/trim/source/
COPY .codex/packaging-probes/trim-cpu-resolution-20261008/proof-image-context/panns-pypi-0.1.1.json /usr/share/licenses/vocalis/trim/source/
COPY packaging/trim/local-inputs.patch packaging/trim/panns-artifacts.lock.json packaging/trim/PANNs-LICENSE.MIT /usr/share/licenses/vocalis/trim/source/
COPY .codex/packaging-probes/trim-cpu-resolution-20261008/proof-image-context/trim-python-sbom.spdx.json .codex/packaging-probes/trim-cpu-resolution-20261008/proof-image-context/notice-manifest.json /usr/share/licenses/vocalis/trim/source/
COPY packaging/models/trim/ /usr/share/licenses/vocalis/trim/models/
COPY packaging/trim/requirements.cpu.in packaging/trim/requirements.cpu.lock packaging/trim/apply_local_inputs.py /usr/share/licenses/vocalis/trim/source/
ENV VOCALIS_TRIM_VENV=/opt/vocalis/venvs/trim \
    VOCALIS_TRIM_MODEL_ROOT=/models/vocalis/trim \
    NUMBA_CACHE_DIR=/cache/vocalis/numba MPLCONFIGDIR=/cache/vocalis/matplotlib \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
RUN /opt/vocalis/venvs/trim/bin/python -m pip check \
 && echo "${SCORER_SHA256}  /opt/vocalis/scripts/cleanup/trim_scores.py" | sha256sum -c - \
 && /opt/vocalis/venvs/trim/bin/python -c "import hashlib,pathlib,sys,torch,torchaudio,soundfile,silero_vad; root=pathlib.Path('/opt/vocalis/venvs/trim/lib/python3.12/site-packages/panns_inference'); assert sys.version_info[:3] == (3, 12, 15); assert torch.__version__ == '2.6.0+cpu'; assert torch.version.cuda is None and not torch.cuda.is_available(); assert torchaudio.__version__ == '2.6.0+cpu'; assert soundfile.__libsndfile_version__; assert hashlib.sha256((root/'config.py').read_bytes()).hexdigest() == '8e8b58fb8503a4e6b064a8639b07d3581d2b8bb924d6c1e1fe218308fc6d30d3'; assert hashlib.sha256((root/'inference.py').read_bytes()).hexdigest() == '4293ddce865bdf00dbfc4c067c596940619162dea2e1f40d15e337ebf890e775'; assert not (root/'__pycache__'/'config.cpython-312.pyc').exists(); assert not (root/'__pycache__'/'inference.cpython-312.pyc').exists(); assert not pathlib.Path('/models/vocalis/trim/Cnn14_mAP=0.431.pth').exists(); print('TRIM_CPU_IMPORTS=PASS', soundfile.__libsndfile_version__)" \
 && test ! -e /tmp/trim-wheelhouse
USER 1000:1000
