# DeepFilterNet3 model weights notice

This notice applies to the two files selected in [model-file-lock.json](model-file-lock.json), which setup downloads from the publisher at the user's install. No Vocalis image or archive carries these weights.

## Source

- Repository: <https://github.com/Rikorose/DeepFilterNet>, revision `d375b2d8309e0935d165700c91da9de862a99c31`.
- The publisher offers the weights only inside one archive: <https://raw.githubusercontent.com/Rikorose/DeepFilterNet/d375b2d8309e0935d165700c91da9de862a99c31/models/DeepFilterNet3.zip>, 7,986,207 bytes, SHA-256 `49c52edc8947ae1f9bf50d81530beaf3a2c3245aeaf34b6f31ff535cd22284d2`.
- Setup verifies the archive's size and SHA-256, extracts only these two members by exact name, verifies each member's size and SHA-256, and deletes the archive:
  - `DeepFilterNet3/config.ini` to `config.ini` (2,067 bytes, SHA-256 `415eb925d44990d938fb739f514aa3662c1ec0ea836cff044fa1291b82cb4290`);
  - `DeepFilterNet3/checkpoints/model_120.ckpt.best` to `checkpoints/model_120.ckpt.best` (8,714,073 bytes, SHA-256 `23b92884f63ccf54bb026014604625ab231657b6480df65db4095c4c171e6003`).
- Destination: `VOCALIS_DFN_MODEL_ROOT` (`/models/vocalis/cleanup/dfn3` in the image).

## License choice

The repository's root license (`LICENSE`) offers the DeepFilterNet code under either Apache-2.0 or MIT at the recipient's option. Both exact pinned texts are the ones already shipped in [packaging/dfn/notices](../../dfn/notices) (`LICENSE-MIT`, `LICENSE-APACHE`, `LICENSE`; in the image under `/usr/share/licenses/vocalis/dfn/`). They are copies from the pinned DFN 0.5.6 runtime wheels and match the same files at the source revision above. Those notices cover the software; they do not grant rights to this model snapshot.

## Redistribution

Setup downloads these two files from the publisher at the user's install; no Vocalis image or archive carries them. Whether the weights may be redistributed is not settled (`redistributionResolved: false` in the lock): the repository license covers the code and does not grant rights to the weights, and the paper's license is not assigned to them. The authors' combined weight-publication statement and the official DeepFilterNet3 linkage support downloading from the publisher. This notice does not claim that redistribution is permitted.
