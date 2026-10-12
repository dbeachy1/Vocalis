# Clean up — the 4.4 PoC scripts

Two composable AI passes that clean an uploaded voice clip **before** it becomes a training
clip (`DESIGN_4_4_CLEANUP`). These began as the **PoC-first** standalone scripts (§7):
run them against representative audio, listen, and pick settings by ear. **DeepFilterNet3**
is the selected denoiser, and the in-app workspace (§3),
the kept/dropped timeline and the `cleanup_rate` estimator (§5) are wired by `src/cleanup.py`
and the `/cleanup/*` routes.

Both children are **path in, path out** and know nothing about the vault (the same seam
contract as `scripts/enhance/` and `scripts/voiceswap/`). The parent `src/cleanup.py` owns
scratch / cache / cancel exactly as `src/enhance.py` does for enhancement.

## Trim — auto-curate (`trim_audio.py`)

Keep the clean speech, drop the noisy/SFX stretches, write the survivors as separate takes.
The **primary** tool: cutting a segment costs nothing you can't spare from 90 minutes.

- **Venv:** the ordinary Vocalis venv (numpy + soundfile + ffmpeg). No GPU, no enhance venv.
- **The scorer:** each speech region's own background (its inter-word gaps) measured against
  the file's *quietest* background. A region whose gaps sit well above the pristine floor is
  the noisy one. The one tunable is `--max-excess-db` — pick it by ear with `--sweep` first.
- **Known limit:** catches broadband noise (hiss, ambient, room tone). It does **not** catch
  loud SFX / music — that's the audio-tagger augment (§2.3). The VAD is a plain energy gate;
  Silero VAD (§2.1) is the documented upgrade.

```bash
# 1. see how much you'd keep at several thresholds (writes nothing):
python scripts/cleanup/trim_audio.py -i reading.wav --sweep 3,6,9,12

# 2. commit to a line and write the kept takes to out/reading.takeNN.wav:
python scripts/cleanup/trim_audio.py -i reading.wav -o out/reading --max-excess-db 6
```

## Denoise — speech enhancement (`denoise_dfn.py` — the chosen child)

Pull the voice out of whatever background is left, **without** cutting. The **fallback** for
noise you can't afford to cut (smeared throughout, or a clip already too short to trim).

Listening tests selected DeepFilterNet3 (design §2.2): it nearly silenced a loud sound effect
while keeping the voice clean, and beat the alternatives evaluated.
It is a single-output denoiser (no stem to bleed into) and runs **CPU, real-time++**, so a Clean
up pass never competes with a render or a training for a GPU.

- **Venv:** its own **`~/dfn-venv`** (Python 3.11 — DeepFilterNet's wheels stop at cp311). Install
  once with `./scripts/cleanup/setup_dfn.sh`.
- **Strength** is an honest dry/wet mix: `1.0` is fully denoised (the ear-test winner), `0.4`
  keeps 60% of the true recording. `--wet-sweep` denoises **once** and writes one clip per level,
  so a whole A/B set is a single pass. `--atten <dB>` caps how far DeepFilterNet may attenuate
  (its own gentleness knob); left off it denoises fully.

```bash
# an A/B set at three strengths from one CPU pass:
~/dfn-venv/bin/python scripts/cleanup/denoise_dfn.py \
    -i reading.wav -o reading.denoised.wav --wet-sweep 1.0,0.7,0.4
# → reading.denoised.wet100.wav / .wet070.wav / .wet040.wav

# a single strength:
~/dfn-venv/bin/python scripts/cleanup/denoise_dfn.py -i reading.wav -o out.wav --wet 1.0
```

> **`denoise_audio.py` is the superseded resemble-enhance PoC of record.** Its `inf.denoise()`
> was inert on the quiet in-band texture that mattered (~−37 dB of change — essentially nothing,
> §2.2), so DeepFilterNet3 replaced it. It is kept, frozen, as the ear test's other data point;
> the app runs `denoise_dfn.py`. The dry/wet mix + sweep-naming logic both children share lives
> once in `_mix.py`.

## Composing them (§2)

Either alone, both in sequence, or neither. When chaining a noisy upload, the order is
**Trim → Denoise → (later) Enhance**: cut the dirty stretches, denoise the real survivors,
and only then — if it's headed for training — bandwidth-extend (§10.4). Denoise runs on the
**real** recording, never on already-enhanced audio.
