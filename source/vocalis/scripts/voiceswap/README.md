# ACE-Step voice-swap pipeline (ROCm)

Automates everything **after** you generate a song in ACE-Step: split the mix,
swap the vocal to a target voice, and remix it back into a finished track — all
headless on configured ROCm devices. No Audacity scripting required.

```
ACE-Step (Gradio, manual)          this pipeline (headless)
  make the song  ─────────►  song.wav ─► Demucs ─► vocals.wav ─► RVC swap ─┐
                                             └─► no_vocals.wav ─────────────┤
                                                                            ▼
                                                          ffmpeg remux ─► out.wav
```

## Why this shape

- **ACE-Step can't do the voice swap.** It's a music-generation model, not a
  voice-conversion model — it cannot re-sing an existing vocal as a different
  person. That step is **RVC** (Retrieval-based Voice Conversion), a separate
  tool this pipeline installs and drives.
- **Demucs, not ACE-Step `extract`, does the split.** `extract` only runs on a
  *pure base* model (`acestep-v15-xl-base`, which isn't on disk) and isolates
  **one instrument at a time** — there's no single "instrumental" stem. Demucs
  gives a clean vocal / no-vocals split in one pass, so **you keep running your
  usual `acestep-v15-xl-sft`** for making the song.
- **ffmpeg, not Audacity, does the mix-back.** One filter does the overlay
  headlessly. Audacity stays your tool for *manual* touch-up, not automation.

## One-time setup

```bash
./scripts/voiceswap/setup.sh
```

Builds an **isolated** venv at `~/voiceswap-venv` (never touches the working
ACE-Step `.venv`) with ROCm 6.4 PyTorch — matching ACE-Step's known-good
`torch 2.9.1+rocm6.4` — plus Demucs and rvc-python. Override the location with
`VOICESWAP_VENV=/path ./scripts/voiceswap/setup.sh`. (The default is `$HOME`,
not `/ai-models` — that tree is treated as reproducible/disposable, which is
wrong for a permanent toolchain.)

The venv is **Python 3.10** with **numpy pinned to 1.26.4** to match the validated
environment; see the header comment in
`setup.sh` for the why (fairseq can't import on 3.11+, numpy 1.25.2 can't
build, numpy 2.x breaks the pyworld/parselmouth C-extensions).

## The prerequisite you must supply: a target-voice model

RVC swaps *to* a trained voice. You need an RVC model (`.pth`, optionally with a
`.index`) of the voice you want. Two ways to get one:

1. **Train your own** (only ethical route for a real person's voice — get their
   consent): collect ~10 min of clean, solo, dry vocal audio of the target, then
   train with the **RVC WebUI** or **Applio** (both ROCm-capable). Produces the
   `.pth` + `.index` you point this pipeline at.
2. **Use a model you already have** the rights to.

> Only swap voices you're allowed to. Don't impersonate real people without
> consent — releasing a track that sounds like someone singing is exactly the
> case where that matters.

## Usage

```bash
./scripts/voiceswap/voiceswap.sh \
    -i ~/ACE-Step-1.5/gradio_outputs/mysong.wav \
    -m /ai-models/rvc/target_voice.pth \
    --index /ai-models/rvc/target_voice.index \
    --pitch 0 \
    -o ~/mysong_swapped.wav
```

Useful flags: `--pitch N` (semitone transpose — e.g. `+12`/`-12` to shift an
octave when swapping across a big vocal-range gap), `--index-rate 0..1` (how
hard to pull toward the target timbre), `--device cuda:1` (use the second
R9700), `--keep-stems` (keep the Demucs/ RVC intermediates), `--vocal-gain` /
`--backing-gain` (balance the remix). `voiceswap.sh -h` lists them all.

## Troubleshooting the RVC install

`rvc-python` is the one dependency that can fight a modern Python/torch. If step
4 of `setup.sh` fails:

- It pulls `fairseq`/`faiss`/`pyworld`/`praat-parselmouth`; a build error is
  usually one of those. Installing system `build-essential` + `cmake` fixes most.
- If it tries to downgrade torch, reinstall the ROCm torch afterward:
  `uv pip install --python ~/voiceswap-venv/bin/python torch torchaudio --index-url https://download.pytorch.org/whl/rocm6.4`.
- The RVC call itself lives in `rvc_infer.py` — if a future rvc-python renames a
  method, that single file is the only thing to adjust; the orchestrator
  stays put. Known quirk in the installed version: `RVCInference.infer_file`
  masks conversion errors (its `vc_single` returns a traceback tuple instead of
  raising), which is why `rvc_infer.py` calls `vc_single` directly.

## Validation evidence

- ffmpeg 8 present; ROCm torch 2.9.1 sees the configured GPUs; venv verify gate green.
- Demucs: a full 3:45 track split in ~24 s on the test GPU (the
  `MIOpen ... IsEnoughWorkspace` lines are workspace-probe warnings, benign).
- rvc-python: model load verified with an Applio-trained `.pth`+`.index`
  (the two RVC ecosystems interoperate); first full conversion happens in the
  Vocalis Voice Swap build.
- On first run rvc-python auto-downloads `hubert_base.pt` / `rmvpe.pt` into its
  package dir; one caught fairseq `weights_only` traceback prints during hubert
  load — handled and benign (torch 2.9 default flip).
