# Mnemosyne embedding model attribution

The Taproom image configures the quantized Transformers.js model `Xenova/multi-qa-mpnet-base-cos-v1`, unpinned (no revision), as `extensions.models.embedding`. It is the model every existing Taproom/Mnemosyne store already uses, so adopted stores recall their memories with no configuration change. The Xenova repository is an ONNX conversion of `sentence-transformers/multi-qa-mpnet-base-cos-v1`.

**No weights are shipped.** No image, archive or source offer carries this model. Taproom downloads the files from the publisher (Hugging Face) into `<dataRoot>/_cache` at the user's installation, on first use, exactly as every standalone installation already does; an installation that already holds the model in its `_cache` reuses that copy. This is the same footing as DeepFilterNet3.

**License: not stated.** Neither the Xenova conversion card nor the sentence-transformers card declares a license, and neither repository's Hugging Face metadata has a license field. This package therefore includes no license text for the model and asserts none. Whether the weights may be redistributed is not settled, as for DeepFilterNet3 (see [`../dfn3/NOTICE.md`](../dfn3/NOTICE.md)); it does not affect end-user download at installation, and it would have to be settled before any bundle or image carried the weights.

Observed on October 10, 2026: the head revision of the conversion is `342c63cb07c8b4f462b14318f1cdbc626d84faeb` (last modified 2025-07-22); the head of the base repository is `d51b22a1dfa8184e9258074e56e2875e50612dca` (last modified 2025-08-19). These are observations, not pins. The file names, sizes and SHA-256 values for the six-file quantized set at the observed head are listed in `manifest.json`.

This October 10 selection replaces the October 8 `Xenova/all-mpnet-base-v2` (pinned, Apache-2.0 base) selection for the packaged default; see Implementation Design section 8. It does not change explicit later user model choices, retrieval thresholds or the global `extensions.models.autoDownload` setting.
