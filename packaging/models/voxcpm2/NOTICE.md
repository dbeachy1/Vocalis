# VoxCPM2 model and source notices

The files selected for private evaluation are pinned in [model-file-lock.json](model-file-lock.json). Their exact sizes and upstream content identifiers, plus independently computed SHA-256 values, are recorded in [acquisition-verification.json](acquisition-verification.json). The acquired model snapshot retains the pinned upstream `README.md`.

## Model repository

The pinned `openbmb/VoxCPM2` model card at revision `32279effe8c19989596f05d353d1447f51d9e915` declares Apache-2.0 and states the model is free for commercial use. Its README is included in the acquired snapshot (7,939 bytes; SHA-256 `c18d2ffbfb2f0aec770481c967842aee6c200cde65f6b033efd892a849986fda`). The model repository has no separate `LICENSE` file.

The model card says use for impersonation, fraud, or disinformation is strictly forbidden and that AI-generated content should be clearly labeled. It also recommends production testing and safety evaluation appropriate to the use case. Preserve the full pinned README with the model files so this guidance remains available alongside the weights.

## Source repository

The VoxCPM library source is pinned to OpenBMB/VoxCPM v2.0.0, commit `a010d621ff9a1dce83ce9c934919b24f28073e90`. Its exact upstream Apache-2.0 `LICENSE` is preserved as [LICENSE-source.txt](LICENSE-source.txt), SHA-256 `4f10acc209addacfad28293315c74c4cd648f771ee1263a748f1781d1e0265e4`. This source license text is retained with the source-package provenance; the model repository's separate Apache-2.0 declaration remains in its pinned README.

## Selection and scope

The eight selected model files total 4,960,730,347 bytes. The worker calls `VoxCPM.from_pretrained(..., load_denoiser=False)`: the model's own `audiovae.pth` remains part of the selection, while the optional external input/reference-audio denoiser is not acquired. No separate teacher model or floating revision is included.

These files have not been imported into the application or used to generate audio. Dependency closure, source delivery, runtime compatibility, and any later release review remain separate gates. This notice index does not claim overall distribution compliance.
