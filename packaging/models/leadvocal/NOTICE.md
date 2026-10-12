# Lead Vocal model files notice

This notice applies to the nine files selected in [model-file-lock.json](model-file-lock.json), which setup downloads from the publishers at the user's install. **No weights are shipped.** No Vocalis image, archive or repository carries these files, and the application never downloads a model while it runs.

Lead Vocal runs the MIT-licensed audio-separator 0.44.5 (<https://github.com/nomadkaraoke/python-audio-separator>) over models and parameter files of the Ultimate Vocal Remover (UVR) project. These are exactly the files that audio-separator reads from its model folder for the karaoke detector and for each de-reverb choice the product offers. Destination: `LEADVOCAL_MODELS` (`/models/vocalis/leadvocal` in the image), the folder Lead Vocal itself reads.

## Files and addresses

The addresses are the ones audio-separator 0.44.5 itself uses, read from its `separator.py` and `models.json`. For each model file it tries the UVR release first and the audio-separator release second; the address below is the one that answered.

| File | Role | Bytes | SHA-256 | Address |
| --- | --- | --- | --- | --- |
| `UVR_MDXNET_KARA_2.onnx` | karaoke detector | 52,786,726 | `bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4` | <https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_KARA_2.onnx> |
| `UVR-DeEcho-DeReverb.pth` | de-reverb, the default (listed as "VR Arch Single Model v5: UVR-DeEcho-DeReverb by FoxJoy") | 223,650,277 | `e644028ec82865dc0fe082bc6fea85a43f7c71cfe375caee2da2d154aa661ee7` | <https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-DeEcho-DeReverb.pth> |
| `UVR-De-Reverb-aufr33-jarredou.pth` | de-reverb (listed as "VR Arch Single Model v4: UVR-De-Reverb by aufr33-jarredou") | 58,928,133 | `fff726b0adf09f2eadc2151645557db81e1a01fe15d91f9bbbfa9b50a007f1fd` | <https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/UVR-De-Reverb-aufr33-jarredou.pth> |
| `dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt` | de-reverb, Roformer (listed as "MelBand Roformer \| De-Reverb by anvuew") | 913,107,578 | `9262877b87e9ebb0fb808a456b0a411fa677f5df31c8383c1254af531c078970` | <https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt> |
| `dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt` | de-reverb, Roformer (listed as "MelBand Roformer \| De-Reverb Less Aggressive by anvuew") | 913,107,578 | `0db8f1b41c00cead1112e967262a12802fd32e76c0c3a8eb207e772bae25d07b` | <https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/dereverb_mel_band_roformer_less_aggressive_anvuew_sdr_18.8050.ckpt> |
| `dereverb_mel_band_roformer_anvuew.yaml` | configuration both Roformer models share | 1,846 | `1599d9ea717ea2b5b3bc55d936f752b8d0f67baaa3de95acd6d03259a2f37784` | <https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/dereverb_mel_band_roformer_anvuew.yaml> |
| `download_checks.json` | UVR catalog audio-separator searches for every model | 28,267 | `d3622e1fa19c161d3cf704927711b453d593a3f1eb0f2e0838c3136907935151` | <https://raw.githubusercontent.com/TRvlvr/application_data/3826b05b570dbd4fbedbc807758803b35348ba1b/filelists/download_checks.json> |
| `vr_model_data.json` | VR model parameters, found by the model file's MD5 | 4,380 | `6a2021b9aa355c10f845b68c73944d47bd9e1fdf37b8a584b14ce8f88b09bb2f` | <https://raw.githubusercontent.com/TRvlvr/application_data/3826b05b570dbd4fbedbc807758803b35348ba1b/vr_model_data/model_data_new.json> |
| `mdx_model_data.json` | MDX model parameters, found by the model file's MD5 | 15,358 | `1aca8f9bcc57233bc714029663a9ec2345d9c7721f91e5e08f46392a879c6a9a` | <https://raw.githubusercontent.com/TRvlvr/application_data/3826b05b570dbd4fbedbc807758803b35348ba1b/mdx_model_data/model_data_new.json> |

audio-separator reads the three JSON files from the unpinned `main` branch of `TRvlvr/application_data`. The lock pins them to commit `3826b05b570dbd4fbedbc807758803b35348ba1b`, the head of `main` on October 11, 2026; the three files at that commit are byte-identical to `main` that day. Setup verifies each file's byte count and SHA-256 before it is put in place. The total is 2,161,630,143 bytes.

## What the publishers say

- The UVR project (<https://github.com/Anjok07/ultimatevocalremovergui>) states in its README that the GUI code is MIT-licensed and asks third-party developers who wish to use its models to honor the MIT license by providing credit to UVR and its developers. Credit: Ultimate Vocal Remover and its developers (Anjok07 and the contributors its README credits). The model catalog and release (<https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models>) are the UVR project's own distribution points.
- The catalog names the contributor of `UVR-DeEcho-DeReverb.pth` as FoxJoy, and audio-separator's model list names aufr33 and jarredou for `UVR-De-Reverb-aufr33-jarredou.pth` and anvuew for the two Roformer de-reverb models. The pages the files are published on state no terms of their own for these individual files. The audio-separator release that hosts four of the files calls itself a holding place for large model files (<https://github.com/nomadkaraoke/python-audio-separator/releases/tag/model-configs>); audio-separator's code is MIT-licensed (its GitHub repository record declares the MIT License).
- The karaoke model, `UVR_MDXNET_KARA_2.onnx`, is listed in the UVR catalog as "MDX-Net Model: UVR-MDX-NET Karaoke 2".

## Redistribution

Setup downloads these files from the publishers at the user's install; no Vocalis image or archive carries them. Whether each file may be redistributed is not settled (`redistributionResolved: false` in the lock): the publishers' pages above state the UVR code license and a request for credit, and name contributors, but state no separate terms for the individual model files. This notice records those statements and does not claim that redistribution is permitted.
