# syntax=docker/dockerfile:1.6
# Build from a previously verified CUDA or ROCm application-dependency image.
# The recipe adds the standalone satellite sources, the local-model manifest, the provisioning tool
# and the main package's model fetcher (October 10, 2026: design section 9, "Satellite package: one
# command per operating system"). packaging/build_satellite.py is the recorded command;
# it supplies all three build arguments.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# cuda or rocm. Only the NVIDIA image gets nvidia-ml-py (whole-card memory and readings).
ARG GPU_TYPE
ARG VENV_BIN=/opt/venv/3.12/bin
ARG VOCALIS_UID=1000
ARG VOCALIS_GID=1000

ENV PATH=${VENV_BIN}:/opt/python/3.12.15/bin:${PATH} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/cache/vocalis/home \
    HF_HOME=/cache/vocalis/huggingface \
    TORCH_HOME=/cache/vocalis/torch \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    VOCALIS_SATELLITE_CONFIG=/data/vocalis-satellite/satellite.yaml \
    VOCALIS_SATELLITE_CERT_DIR=/data/vocalis-satellite/certs \
    VOCALIS_SATELLITE_LOG_DIR=/logs/vocalis-satellite \
    VOCALIS_SATELLITE_WORK_DIR=/work/vocalis-satellite \
    VOCALIS_SATELLITE_SECRET_FILE=/run/secrets/vocalis-satellite-master \
    VOCALIS_REQUIRE_LOCALMODEL=1 \
    VOCALIS_CHATTERBOX_MODEL_DIR=/models/vocalis/chatterbox/5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18

WORKDIR /opt/vocalis/satellite

COPY --chown=0:0 source/vocalis/satellite/ /opt/vocalis/satellite/
COPY --chown=0:0 source/vocalis/src/tts_utils.py /opt/vocalis/src/tts_utils.py
# tts_utils.py has imported engine_process since October 9 (commit 9802147). Without this file an
# image builds, passes the old import check and then cannot load a model (found October 10, 2026).
COPY --chown=0:0 source/vocalis/src/engine_process.py /opt/vocalis/src/engine_process.py
COPY --chown=0:0 packaging/satellite/satellite_admin.py /opt/vocalis/satellite-admin/satellite_admin.py
# The main package's fetcher, unchanged and at the path the main image uses; satellite_admin.py
# builds a Chatterbox-only plan from its functions.
COPY --chown=0:0 packaging/models/fetch_models.py /usr/share/vocalis-g1/models/fetch_models.py
COPY --chown=0:0 source/vocalis/LICENSE /usr/share/licenses/vocalis-g1/Vocalis-LICENSE
COPY --chown=0:0 packaging/models/chatterbox/manifest.json /usr/share/vocalis-g1/chatterbox-model-manifest.json
COPY --chown=0:0 packaging/models/chatterbox/NOTICE.md /usr/share/licenses/vocalis-g1/chatterbox-model-NOTICE.md

# nvidia-ml-py (NVML bindings), NVIDIA image only: from the pinned wheel in the build context, with
# no index, no dependencies and hash checking, so the build stays offline (design section 10,
# "Whole-card memory and readings"). The context is bind-mounted for this step only, so the wheel
# is not left in any layer, and the ROCm image never sees it. The license text goes beside the others,
# mode 0444 on purpose: read-only like every other license file in this image (see the chmod below).
RUN --mount=type=bind,source=packaging/nvml,target=/nvml \
    case "${GPU_TYPE}" in \
      cuda) python -m pip install --no-index --no-deps --require-hashes --only-binary=:all: \
              --find-links=/nvml -r /nvml/requirements.lock \
            && install -D -m 0444 /nvml/LICENSE-nvidia-ml-py.txt \
              /usr/share/licenses/vocalis-g1/nvidia-ml-py-LICENSE.txt ;; \
      rocm) echo "ROCm image: nvidia-ml-py is not installed" ;; \
      *) echo "GPU_TYPE must be cuda or rocm, got '${GPU_TYPE}'" >&2; exit 1 ;; \
    esac

# October 11, 2026: license texts and notices for the libraries this image carries, so they are in the image and not only
# in the repository. Every satellite image has the LGPL-2.1 text (soxr, and the libsndfile build inside the soundfile
# wheel) and the GPL-3.0 text (the GCC runtime library copies inside the NumPy, SciPy and PyTorch wheels, the same
# wheels and the same text the main image has); the AMD image also gets the ROCm component notices, the same files the AMD main image carries at
# /usr/share/licenses/vocalis/stems/rocm/ (here under /usr/share/licenses/vocalis-g1/rocm/). Read-only like the other
# license files. Where the source of these libraries is: packaging/licenses/NOTICE.md.
RUN --mount=type=bind,source=packaging/licenses,target=/lic \
    set -eu; \
    install -D -m 0444 /lic/LGPL-2.1.txt /usr/share/licenses/vocalis-g1/LGPL-2.1.txt; \
    install -D -m 0444 /lic/GPL-3.0.txt /usr/share/licenses/vocalis-g1/GPL-3.0.txt; \
    case "${GPU_TYPE}" in \
      rocm) mkdir -p /usr/share/licenses/vocalis-g1/rocm \
            && cp -a /lic/rocm/. /usr/share/licenses/vocalis-g1/rocm/ \
            && cp /lic/rocm-notice-artifacts.json /usr/share/licenses/vocalis-g1/rocm-notice-artifacts.json \
            && chmod -R a-w /usr/share/licenses/vocalis-g1/rocm /usr/share/licenses/vocalis-g1/rocm-notice-artifacts.json ;; \
      cuda) echo "NVIDIA image: no ROCm notices" ;; \
      *) echo "GPU_TYPE must be cuda or rocm, got '${GPU_TYPE}'" >&2; exit 1 ;; \
    esac

# Keep the application code immutable; all runtime writes use external mounts.
RUN chmod -R a-w /opt/vocalis/satellite /opt/vocalis/satellite-admin /opt/vocalis/src \
    && chmod a-w /usr/share/licenses/vocalis-g1/Vocalis-LICENSE \
    && chmod a-w /usr/share/vocalis-g1/models/fetch_models.py \
    && chmod a-w /usr/share/vocalis-g1/chatterbox-model-manifest.json \
    && chmod a-w /usr/share/licenses/vocalis-g1/chatterbox-model-NOTICE.md \
    && python - <<'PY'
import importlib.metadata as metadata
import importlib.util
import os
import sys

if sys.version_info[:2] != (3, 12):
    raise SystemExit(f"unexpected Python runtime: {sys.version}")
for module in ("flask", "cryptography", "yaml", "numpy", "torch", "chatterbox"):
    __import__(module)
sys.path.insert(0, "/opt/vocalis/satellite")
import server
if server.app is None:
    raise SystemExit("satellite Flask application did not import")
if metadata.version("chatterbox-tts") != "0.1.7+vocalis.1":
    raise SystemExit("unexpected local Chatterbox package")
# The satellite imports tts_utils at start (server.py's whole-card memory source step) and again
# for the model check; import it here so a missing helper module fails the build instead of the
# first start (October 10, 2026).
sys.path.insert(0, "/opt/vocalis/src")
import tts_utils
if os.environ["GPU_TYPE"] == "cuda":
    import pynvml
    if metadata.version("nvidia-ml-py") != "13.615.71":
        raise SystemExit("unexpected nvidia-ml-py")
elif importlib.util.find_spec("pynvml") is not None:
    raise SystemExit("pynvml must not be installed in the ROCm image")
for name, path in (("satellite_admin", "/opt/vocalis/satellite-admin/satellite_admin.py"),
                   ("fetch_models", "/usr/share/vocalis-g1/models/fetch_models.py")):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
print("SATELLITE_IMPORT_SMOKE=PASS")
PY

USER ${VOCALIS_UID}:${VOCALIS_GID}
EXPOSE 7880
ENTRYPOINT ["python", "server.py"]
