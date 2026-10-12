# ACE engine build inputs

This directory records the exact CUDA and ROCm ACE-Step engine recipes used by
the private candidate images. `engine-build-inputs.json` binds each recipe to
its clean application-dependency parent, locked Python environment, patched
ACE source tree, model-lock reference, and the native audio inputs exercised by
the successful builds. The CUDA recipe defaults to its CUDA lock values; the
ROCm recipe retains the ROCm lock values.

The accepted ACE native audio set is the eight-row lock under `native/`. The
context preparer verifies those rows are exactly the matching subset of the
current nine-row `packaging/main-cuda/ffmpeg-native.lock`. It deliberately
leaves `libsamplerate0` in the shared main lock for LeadVocal and out of ACE's
tested package set. It also checks the exact profile wheel set, source tree,
FFmpeg artifact tree, and native package archive hashes before creating a
context. It does not fetch dependencies or start a build.

Prepare a fresh context after obtaining the locked binary build inputs:

```powershell
python packaging/acestep/prepare-engine-context.py `
  --profile cuda `
  --source-archive <verified-pinned-source-tar.gz> `
  --source-tree <patched-source-tree> `
  --wheelhouse <directory-containing-files> `
  --ffmpeg-artifacts <verified-ffmpeg-output-root-containing-usr> `
  --ffmpeg-debs <directory-containing-the-eight-locked-debs> `
  --output <new-task-owned-context-directory>
```

For ROCm, set `--profile rocm` and use its exact 107-wheel environment. The
prepared directory contains `context/` and a `prepared-context.json` hash
record. Buildx still needs the external wheelhouse and deb directories as named
contexts `ace-wheelhouse` and `ffmpeg-debs`; use the parent application image
ID recorded for that profile, not an older GPU image. Keep the build network
disabled and follow the project’s bounded build-owner procedure.

The upstream source archive and its patched source tree are external verified
inputs; the preparer requires both explicitly. To reconstruct the tree, extract
the pinned archive and apply the four patches from the extracted repository
root in this order:

```powershell
tar -xzf <verified-pinned-source-tar.gz> -C <new-source-parent>
$source = '<new-source-parent>\ACE-Step-1.5-6d467e4b5081ccb0abf1ec1bf4fdf9051a2d34b0'
$package = '<path-to-package>\packaging\acestep'
git -C $source apply "$package\inputs\patches\api-widening.patch"
git -C $source apply "$package\inputs\patches\lm-dtype.patch"
git -C $source apply "$package\inputs\patches\tempdir-cache.patch"
git -C $source apply "$package\local-model-root.patch"
```

`local-model-root.patch` covers only the paths that read `ACESTEP_CHECKPOINTS_DIR`
(startup init, `/v1/init`, model routes, the downloader refusal). Eight other upstream
paths still join `<source>/checkpoints`: lazy LM init (`api/llm_readiness.py`), reinitialize,
the sample/format helpers, LM switching (`api/runtime_helpers.py`), the init orchestrator and
the pipeline. The main app image links `/opt/acestep/checkpoints` to the model mount so those
work (M1 on the AMD test host: every Think/CoT render failed with status 2 without it). When the engine is
rebuilt, extend this patch to those sites and remove the link.

The helper validates the archive SHA and every patched-tree file against the
tracked source-tree manifest before staging either one. Both tested engine
recipes copy the tree to `/opt/acestep`, the pinned source archive to
`/usr/share/licenses/vocalis/acestep/ACE-Step-source.tar.gz`, and the upstream
MIT license to `/usr/share/licenses/vocalis/acestep/LICENSE`.
Promoted JSON manifests use LF line endings so their locked file hashes remain
stable in a clean checkout; the historical CRLF hashes from successful image
contexts remain recorded separately in `engine-build-inputs.json`.
The model weights, Python wheel archives, compiled FFmpeg outputs, and Ubuntu
package archives are not embedded in this source directory; the preparer
verifies the last three when supplied from their existing acquisition
locations. This record does not close the applicable wheel-notice review or
the final release source offer. Exact LGPL native-source associations and the
remaining delivery boundary are listed in `engine-build-inputs.json` and
`../licenses/apt-runtime-source-artifacts.json`.
