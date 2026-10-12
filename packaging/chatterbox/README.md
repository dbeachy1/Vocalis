# Vocalis Chatterbox wheel

This directory is the shared Chatterbox artifact used by the packaged CUDA and ROCm dependency graphs and the Windows/Linux satellite installers.

The wheel is built from the official Chatterbox 0.1.7 source distribution (SHA-256 `ed8afae83819b40a25927c2ef3bcc67f928bdfcf434c1376c972e6039252a187`) with [the downstream patch](chatterbox-downstream.patch). The patch changes the package version to `0.1.7+vocalis.1` and removes only the unused `pykakasi==2.3.0` dependency. It does not alter Python source files. The English `EnTokenizer` path remains the supported Vocalis path.

The artifact manifest records the exact wheel hash, upstream source and license hashes, patch hash, setuptools version, and `SOURCE_DATE_EPOCH`. The wheel is installed with `--no-deps`; each runtime's complete pinned dependency lock remains responsible for its Torch/vendor graph and is checked with `pip check`.

To reproduce the wheel, download the exact official source archive URL in `artifact-manifest.json`, verify its byte count and SHA-256, extract it, apply `chatterbox-downstream.patch` at the source root, then run `python -m pip wheel --no-index --no-deps --no-build-isolation --no-cache-dir --wheel-dir=wheelhouse <source-directory>` using setuptools 78.1.0 and `SOURCE_DATE_EPOCH=1774514627`. The resulting wheel is `chatterbox_tts-0.1.7+vocalis.1-py3-none-any.whl`.
