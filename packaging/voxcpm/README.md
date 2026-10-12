# VoxCPM2 inference inputs

The exact upstream source is OpenBMB/VoxCPM v2.0.0 at
`a010d621ff9a1dce83ce9c934919b24f28073e90`. Its complete source archive,
Apache 2.0 license, original pyproject and uv lock are retained by the recorded
source input. The runtime copies its exact 33-file package without running an
SCM-sensitive setup build. Original upstream metadata is not rewritten.

Use `requirements.cuda.inference.lock` or `requirements.rocm.inference.lock` for
the isolated inference environment. The broader `requirements.rocm.in` and
`constraints.upstream.txt` are metadata investigation inputs, not runtime locks.
That full metadata expansion cannot be installed as a wheel-only inference
closure because unused training/demo requirements include an unavailable argbind
wheel. The retained worker needs neither training/demo tools nor optional text
normalization/ZipEnhancer paths. It loads with `load_denoiser=False`; the frozen
normal generation path does not normalize or denoise reference audio. No package
is stubbed to suppress a missing inference dependency.

CUDA selects 77 wheels: 65 exact gathered artifacts and 12 already-verified staged
wheels. ROCm selects 71 wheels: 57 exact gathered artifacts and 14 staged wheels.
Both were installed offline into new empty `/opt/vocalis/venvs/voxcpm2`
environments and passed `pip check`. The images retain the complete source
archive/license and source, wheel, and dependency-lock manifests. These are
isolated proof images, not the combined release image.

The worker selects its requested Torch device before importing VoxCPM and uses
the pinned constructor/generation signatures. Each serial request seeds Torch
before generation instead of passing an unsupported `seed` keyword. Both GPU
profiles generated the same short synthetic text from the frozen eight-file
model snapshot with networking disabled. Model parameter placement, worker
READY/response protocol, finite non-silent audio, and exact-container removal
were checked.
