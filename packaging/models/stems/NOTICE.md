# HTDemucs model weights notice

This notice applies to the one file selected in [model-file-lock.json](model-file-lock.json), which setup downloads from the publisher at the user's install. **No weights are shipped.** No Vocalis image, archive or repository carries this file, and the application never downloads a model while it runs.

## Source

- Model: `htdemucs`, model `955717e8` (the single model in Demucs's `htdemucs` bag), from Demucs, music source separation by Alexandre Defossez. The code is at <https://github.com/facebookresearch/demucs> (archived) and <https://github.com/adefossez/demucs> (maintained).
- File: `955717e8-8726e21a.th`, 84,141,911 bytes, SHA-256 `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`.
- Address: <https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th>. This is the address Demucs 4.0.1 itself downloads from: `demucs/pretrained.py` sets the root `https://dl.fbaipublicfiles.com/demucs/`, and `demucs/remote/files.txt` lists `955717e8-8726e21a.th` under `hybrid_transformer/`.
- Setup verifies the byte count and the SHA-256 before the file is put in place.
- Destination: `VOCALIS_STEMS_MODEL_ROOT` (`/models/vocalis/stems` in the image), at `hub/checkpoints/955717e8-8726e21a.th`. The application hands the Demucs child that folder as its `TORCH_HOME`, so `torch.hub` finds the file there and has nothing to download.

## What the publisher says

- The Demucs code is released under the MIT license (its `LICENSE` file; the README's License section).
- The author wrote that the model weights are not covered by the MIT license and are provided only for scientific purposes: <https://github.com/facebookresearch/demucs/issues/327#issuecomment-1134828611> (May 23, 2022).
- The author wrote that the weights are provided for research purposes: <https://github.com/facebookresearch/demucs/issues/508#issuecomment-1663033356> (August 2, 2023).
- The author's current HTDemucs model card, <https://huggingface.co/adefossez/HTDemucs/blob/main/README.md>, identifies the same model (`955717e8`) and declares no license for the weights.

## Redistribution

Setup downloads this file from the publisher at the user's install; no Vocalis image or archive carries it. Whether the weights may be redistributed is not settled (`redistributionResolved: false` in the lock). The statements above are the publisher's own; this notice records them and does not claim that redistribution is permitted.