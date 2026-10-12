# Stems component environment

The retained `htdemucs` worker runs in `/opt/vocalis/venvs/stems`. CUDA and ROCm builds use separate, hash-locked Python 3.12 graphs, selected with `PROFILE=cuda` or `PROFILE=rocm` and a verified clean `BASE_IMAGE`.

The component build accepts three named wheel contexts: `common-wheelhouse` for the acquired common artifacts, `vendor-wheelhouse` for the selected Torch family, and `locked-wheel-reuse` for the previously verified derived antlr wheel used by the ROCm graph. The exact Demucs source is supplied as `demucs-source`; the exact lameenc and LAME archives are supplied as `stems-source`. These contexts are read-only build inputs. The resulting component contains the isolated venv and scoped license/source materials, not wheelhouses or model weights.

`source-artifacts.lock.json` pins Demucs 4.0.1 (MIT), lameenc 1.8.4 (LGPL-3.0-or-later), and its statically incorporated LAME 3.100 source (LGPL-2.0). The build creates a local Demucs wheel from the pinned MIT sdist using only the separately locked setuptools build tool. It does not install the optional training/dev dependencies or load a model.

The image build runs `pip check`, imports the pinned Torch/Torchaudio stack, invokes the same Demucs module entry point as the retained worker with `--help`, and performs a short synthetic MP3 encode through the exact locked lameenc wheel. This establishes the CPU package/native import path, not model-based separation or GPU acceptance. For ROCm, exact vendor license texts are copied from the existing `packaging/licenses/rocm` lock inputs. LeadVocal's separate `libsamplerate0` native runtime is not part of this component.

The profile locks `requirements.cuda.lock` and `requirements.rocm.lock` are the resolved dependency records for the two profiles. Source archive hashes are in `source-artifacts.lock.json`; the license notices at `packaging/licenses/NOTICE.md` say where the source of the LGPL parts (lameenc and LAME) is.
