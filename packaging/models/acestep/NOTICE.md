# ACE-Step model and source notices

This notice index applies to the files selected in [model-file-lock.json](model-file-lock.json). The lock pins 49 files: 27 from `ACE-Step/Ace-Step1.5` at revision `571cee88618ae5ef3d3fcdf79c46068ce4e2d727` (the turbo model, the 1.7B language model, the embedding model and the VAE; their acquisition hashes and sizes are recorded in [acquisition-verification.json](acquisition-verification.json)) and, added October 11, 2026, 11 from `ACE-Step/acestep-v15-xl-sft` at revision `d06de46b4622f781cf07f4a013a67d591ca52819` (the larger XL SFT model, 19,953,387,374 bytes, that the music page uses for finished renders) and, added the same day, 11 from `ACE-Step/acestep-v15-xl-base` at revision `220c1166efbdd9583eafcb12eb160594bbfcb241` (the XL Base model, 19,953,388,010 bytes, which the publisher lists for all tasks and which the music page uses for Extract, Replace and Complete). **No weights are shipped:** setup downloads every file from Hugging Face at the user's install, checking its size and hash. The acquired model files remain outside Git.

## Model repository license declaration

The pinned model repository's 24-byte `README.md` declares `license: mit`. The pinned repository has no standalone `LICENSE` file. Preserve that declaration with the model files. The model repository does not provide a separate copyright line in the inspected metadata, so this index does not infer one.

This is distinct from the source-code license text in [ACE-Step-source-MIT.txt](ACE-Step-source-MIT.txt). That byte-exact text comes from `ace-step/ACE-Step-1.5` at source commit `6d467e4b5081ccb0abf1ec1bf4fdf9051a2d34b0`, with SHA-256 `a398a82a348bd27ef8c3ba5e936ae86157088cd13f9b1e5dd5f709ee2159226c`. It preserves that source repository's copyright notice and MIT terms; it does not establish that the source repository's copyright notice applies to model weights.

## XL SFT model repository license declaration

The pinned `ACE-Step/acestep-v15-xl-sft` model card (`README.md`, 4,113 bytes) declares `license: mit` in its front matter; the repository has no standalone `LICENSE` file and no copyright line, so none is inferred. It describes the model as the XL (4B) SFT variant of ACE-Step 1.5. Its `config.json` sets `is_turbo` to false, so the engine's HTTP inventory offers it every task type (the turbo model is offered four, without Extract, Replace (lego) and Complete). That is the engine's rule, not a statement by the publisher: the model card's own table lists this model's tasks as "Standard" and names "All (extract, lego, complete)" only for the XL base model, and the engine's own model table marks Extract, Lego and Complete unsupported for xl-sft. The music page therefore sends those three tasks only to the XL Base model (see below). Preserve the declaration with the model files.

## XL Base model repository license declaration

The pinned `ACE-Step/acestep-v15-xl-base` model card (`README.md`, 4,749 bytes) declares `license: mit` in its front matter; the repository has no standalone `LICENSE` file and no copyright line, so none is inferred. It describes the model as the XL (4B) Base variant, "the foundation model supporting all tasks: text-to-music, cover, repaint, extract, lego, and complete", and its model table lists "All (extract, lego, complete)" for it. Its `config.json` is byte-identical to the one in `acestep-v15-xl-sft` (the same Git blob), so the files do not tell the two models apart; the music page decides by model name. Preserve the declaration with the model files.

## Apache-2.0 code and model lineage

The selected `acestep-v15-turbo/configuration_acestep_v15.py` retains its Apache-2.0 header attributing the Qwen team, Alibaba Group, and Hugging Face Inc. The selected `acestep-v15-turbo/modeling_acestep_v15_turbo.py` retains its Apache-2.0 header attributing the ACESTEO Team. The complete Apache-2.0 text is included in [Apache-2.0.txt](Apache-2.0.txt), SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.

The selected `acestep-v15-xl-sft/configuration_acestep_v15.py` carries the same Qwen team Apache-2.0 header, and `acestep-v15-xl-sft/modeling_acestep_v15_xl_base.py` the ACESTEO Team Apache-2.0 header; `apg_guidance.py` in that folder carries no license header. The Apache-2.0 text above covers them. The selected `acestep-v15-xl-base/configuration_acestep_v15.py`, `acestep-v15-xl-base/modeling_acestep_v15_xl_base.py` and `acestep-v15-xl-base/apg_guidance.py` are the same three files byte for byte (same Git blobs), with the same headers.

The selected Qwen3-Embedding-0.6B and Qwen3-1.7B components have separate official model-card metadata declaring Apache-2.0. The inspected metadata resolved to these revisions:

- Qwen3-Embedding-0.6B: `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`; metadata SHA-256 `b2f249d24a6004dd367fe4351734e95b5cdc5faeedef2e859879426e5bfe4a25`.
- Qwen3-1.7B: `70d244cc86ccca08cf5af4e1e306ecf908b1ad5e`; metadata SHA-256 `ac7e13f9a6735300f632f9040b6712cb1ef2085fcb1745654c10befa3939ca67`.

These records preserve the stated lineage and grants; they do not claim that the selected files are byte-identical to separate Qwen repository files.

## Scope and remaining gates

The lock covers a private-evaluation candidate only. The selected files have not been loaded, executed, or integrated into an image. Dependency compatibility, complete distribution/source obligations, and any later redistribution decision remain separate gates. This notice index does not claim overall license or release compliance.
