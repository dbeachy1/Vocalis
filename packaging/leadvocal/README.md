# LeadVocal audio-separator derivative

This package keeps the upstream MIT-licensed audio-separator 0.44.5 code and applies a two-line metadata patch plus a one-line runtime fix. The package version is `0.44.5+vocalis.2`. The metadata patch changes the version and removes only the Linux `diffq>=0.2` runtime requirement. The separate Windows `diffq-fixed` requirement and every other dependency are preserved.

The runtime fix is in `audio_separator/separator/common_separator.py`, `write_audio`: upstream calls `librosa.get_duration(filename=self.audio_file_path)`, and librosa 1.0.0, which both profile locks pin, removed the `filename=` keyword (it is `path=`). Left alone, every save of a separated stem raised `TypeError: get_duration() got an unexpected keyword argument 'filename'`, so Lead Vocal and the voice clean-up "Remove reverb / echo" step failed for every user (found in the first real run in the container, October 11, 2026; `0.44.5+vocalis.1` carried the defect). The patched line is `librosa.get_duration(path=self.audio_file_path)`, which librosa 1.0.0 implements as `soundfile.info(path).duration`. Every other source file is the upstream file, byte for byte; `audio-separator-source.lock.json` records the upstream and patched hashes of the one changed file. Every other `librosa.` call in the three retained architectures and the shared code already used keyword forms that librosa 1.0.0 accepts.

LeadVocal's retained selections are the MDX karaoke model and four VR/MDXC de-reverb choices. None selects the upstream Demucs architecture that imports `diffq`. Demucs remains a separate retained Stems feature with its own environment and full dependency graph.

## Inputs and verification

`audio-separator-source.lock.json` pins the full upstream commit, source archive URL and SHA-256, MIT license hash, 100-file package manifest, patch hash, build backend wheel, and generated artifact proof. `audio-separator.patch` is the complete source change. The source archive can be acquired from the locked official URL and verified before use.

The tracked `requirements.rocm.in` and `requirements.cuda.in` roots pin separate vendor-matched profiles; their hash locks resolve 67 and 79 distributions, respectively, and both reference the same derived audio-separator wheel hash. The profiles explicitly lock `audioread`, which the retained UVR import path uses even though the upstream package metadata omits it. ROCm pairs its Torch/TorchAudio build with the verified CPU TorchVision wheel for CPU converter helpers; CUDA uses its matching `cu128` TorchVision wheel. The DWT-only `pytorch-wavelets` distribution is installed separately from the derived wheel pinned by `packaging/acestep/dwt1d-distribution.lock.json`; its PyWavelets dependency is in both profile locks.

The offline proof used Poetry Core 2.5.0 and produced two byte-identical derived wheels, and the `pip wheel` frontend produced the same bytes again from two further fresh extractions. The same procedure rebuilt the previous derivation (`0.44.5+vocalis.1`) to the exact wheel hash the earlier lock recorded. The derived wheel's embedded MIT license bytes match the upstream source. Comparing the baseline and derived wheel metadata shows exactly one removed requirement (`diffq` on non-Windows) and the local version change, and comparing their contents shows `common_separator.py` as the only differing source file. This is separate from the component environment checks below.

## Component environment

`Dockerfile` builds `/opt/vocalis/venvs/leadvocal` from one selected profile on a verified clean CUDA or ROCm application base. The `wheelhouse` named context contains only the exact profile-locked artifacts and separately locked DWT wheel; the shared `ffmpeg-debs` context supplies locked Linux `libsamplerate0`. Both profile images built with network-disabled install/smoke steps. Each passed strict `pip check`, imported the retained MDX, VR, and MDXC architecture modules plus `Separator(info_only=True)`, and completed a finite 2,048-sample synthetic libsamplerate operation. The ROCm image uses Torch/TorchAudio `2.10.0+rocm7.14.1` with TorchVision `0.25.0+cpu`; CUDA uses the matching `2.10.0+cu128` stack. No model weights were included or loaded, and no GPU inference was run.

## Rebuild

From the repository root, first acquire and verify the source archive and exact build-backend wheel listed in `audio-separator-source.lock.json`. Extract the upstream archive into a fresh directory while preserving file timestamps, then apply the patch:

```powershell
git -C <fresh-source-directory> apply <repository-root>/packaging/leadvocal/audio-separator.patch
```

Unpack the locked `poetry_core-2.5.0-py3-none-any.whl` into a fresh build-tools directory. With the pinned build tool on `PYTHONPATH`, build only the wheel and avoid dependency installation or index access:

```powershell
$env:PYTHONPATH = '<build-tools-directory>'
$env:PIP_NO_INDEX = '1'
python -m pip wheel --no-build-isolation --no-deps --no-index --wheel-dir <wheel-output> <fresh-source-directory>
```

The resulting wheel must match the filename and SHA-256 in the lock. Build from a second fresh extraction to verify byte-for-byte reproducibility before refreshing either LeadVocal profile lock.
