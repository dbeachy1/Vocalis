"""Stream Chatterbox speech tokens through windowed S3Gen vocoding.

This module is self-contained so the satellite copy can run without the main
`src/` tree. It mirrors the production T3 sampling chain, then vocodes growing
token prefixes with pinned noise, mel overlap, and HiFi-GAN phase continuity.
Waveform tails are held until each crossfade is complete so emitted audio is
never revised. Because flow prefixes can drift, caller-side lookahead keeps
unstable frames out of each emission until enough context is available.
"""
from dataclasses import dataclass
from typing import Generator, Optional

import numpy as np
import torch
import torch.nn.functional as F

# chatterbox/transformers are imported lazily inside the functions that need them,
# so importing THIS module (e.g. from vocalis_server via the stream blueprint)
# stays cheap and the server's startup time is unchanged.

# First valid ID beyond the speech-token range: generate() keeps tokens < 6561
# (drop_invalid_tokens + range filter); we apply the same filter per-token.
SPEECH_VOCAB_SIZE = 6561


@dataclass
class StreamConfig:
    step_tokens: int = 50            # tokens per vocode window (~2 s audio)
    overlap_frames: int = 12         # mel frames crossfaded old->new at a join (~240 ms)
    holdback_tokens: int = 3         # caller-side lookahead (= flow.pre_lookahead_len)
    first_holdback_tokens: int = 10  # deeper holdback before join #1 (least context)
    wave_xfade_s: float = 0.010      # raised-cosine waveform blend at each join
    n_cfm_timesteps: int = 10        # match the pinned one-shot path
    max_new_tokens: int = 1000       # T3 hard cap (chatterbox tts.py)
    noise_seed: Optional[int] = None # pin for reproducible tests; None = fresh
    # Scheduling estimates are local to the server and are not sent to a
    # satellite. Rates are audio-seconds per wall-second per worker.
    governor_rate: float = 0.8       # chunk 1, streaming vocode
    batch_rate: float = 0.7          # chunks 2+, banking (0.8x measured; margin'd)
    governor_margin: float = 1.2     # safety on top of the mathematical floor
    chars_per_second: float = 15.6   # chars per audio-second (measured, §1)


# Explicitly list wire fields so new configuration fields require an intentional
# decision about whether they affect rendering or remain server-local.
RENDER_FIELDS = ("step_tokens", "overlap_frames", "holdback_tokens", "first_holdback_tokens",
                 "wave_xfade_s", "n_cfm_timesteps", "max_new_tokens", "noise_seed")


def render_config(cfg: "StreamConfig") -> dict:
    """The wire form of the render knobs — what `POST /satellite/stream` carries as `config`."""
    return {f: getattr(cfg, f) for f in RENDER_FIELDS}


def config_from_wire(d: dict) -> "StreamConfig":
    """Rebuild a StreamConfig from `render_config()`, ignoring anything unknown.

    Unknown fields are ignored so mixed versions use the receiving satellite's
    defaults for options it does not recognize.
    """
    known = {f: v for f, v in (d or {}).items() if f in RENDER_FIELDS}
    return StreamConfig(**known)


def stream_speech_tokens(model, text: str, *, exaggeration: float = 0.5,
                         cfg_weight: float = 0.5, temperature: float = 0.8,
                         max_new_tokens: int = 1000):
    """Yield clean speech-token IDs (ints < SPEECH_VOCAB_SIZE) as T3 samples them.

    A faithful transcription of the pinned t3.inference() sampling loop with the
    parameter values ChatterboxTTS.generate() passes, plus a per-token yield.
    """
    from chatterbox.tts import punc_norm
    from transformers.generation.logits_process import (
        MinPLogitsWarper,
        RepetitionPenaltyLogitsProcessor,
        TopPLogitsWarper,
    )
    t3 = model.t3
    if exaggeration != model.conds.t3.emotion_adv[0, 0, 0]:
        from chatterbox.models.t3.modules.cond_enc import T3Cond
        _c = model.conds.t3
        model.conds.t3 = T3Cond(
            speaker_emb=_c.speaker_emb,
            cond_prompt_speech_tokens=_c.cond_prompt_speech_tokens,
            emotion_adv=exaggeration * torch.ones(1, 1, 1),
        ).to(device=model.device)

    text = punc_norm(text)
    text_tokens = model.tokenizer.text_to_tokens(text).to(model.device)
    if cfg_weight > 0.0:
        text_tokens = torch.cat([text_tokens, text_tokens], dim=0)
    sot, eot = t3.hp.start_text_token, t3.hp.stop_text_token
    text_tokens = F.pad(text_tokens, (1, 0), value=sot)
    text_tokens = F.pad(text_tokens, (0, 1), value=eot)

    with torch.inference_mode():
        initial_speech = t3.hp.start_speech_token * torch.ones_like(text_tokens[:, :1])
        embeds, _len_cond = t3.prepare_input_embeds(
            t3_cond=model.conds.t3, text_tokens=text_tokens,
            speech_tokens=initial_speech, cfg_weight=cfg_weight,
        )

        # Reuse the pinned backend wrapper (t3.inference builds the same one).
        if not getattr(t3, "compiled", False) or getattr(t3, "patched_model", None) is None:
            from chatterbox.models.t3.inference.t3_hf_backend import T3HuggingfaceBackend
            t3.patched_model = T3HuggingfaceBackend(
                config=t3.cfg, llama=t3.tfmr,
                speech_enc=t3.speech_emb, speech_head=t3.speech_head,
                alignment_stream_analyzer=None,  # English model: pinned path passes None too
            )
            t3.compiled = True

        device = embeds.device
        use_cfg = cfg_weight > 0.0
        bos = torch.tensor([[t3.hp.start_speech_token]], dtype=torch.long, device=device)
        bos_embed = t3.speech_emb(bos) + t3.speech_pos_emb.get_fixed_embedding(0)
        if use_cfg:                       # cfg runs a (cond, uncond) pair; batch must match
            bos_embed = torch.cat([bos_embed, bos_embed])
        inputs_embeds = torch.cat([embeds, bos_embed], dim=1)

        generated_ids = bos.clone()
        # Production sampler chain: ChatterboxTTS.generate() -> t3.inference(
        #   min_p=0.05, top_p=1.0, repetition_penalty=1.2), applied in this order.
        min_p_warper = MinPLogitsWarper(min_p=0.05)
        top_p_warper = TopPLogitsWarper(top_p=1.0)
        rep_processor = RepetitionPenaltyLogitsProcessor(penalty=1.2)

        # Match Chatterbox's inference call. The pinned Transformers backend may
        # ignore this flag under SDPA; this loop does not consume attentions.
        output = t3.patched_model(inputs_embeds=inputs_embeds, past_key_values=None,
                                  use_cache=True, output_attentions=True,
                                  output_hidden_states=True, return_dict=True)
        past = output.past_key_values

        for i in range(max_new_tokens):
            logits_step = output.logits[:, -1, :]
            if use_cfg:
                cond, uncond = logits_step[0:1, :], logits_step[1:2, :]
                cfg = torch.as_tensor(cfg_weight, device=cond.device, dtype=cond.dtype)
                logits = cond + cfg * (cond - uncond)
            else:                          # cfg_weight == 0: single-batch, plain logits
                logits = logits_step[0:1, :]

            ids_for_proc = generated_ids[:1, ...]
            logits = rep_processor(ids_for_proc, logits)
            if temperature != 1.0:
                logits = logits / temperature
            logits = min_p_warper(ids_for_proc, logits)
            logits = top_p_warper(ids_for_proc, logits)

            probs = torch.softmax(logits, dim=-1)
            next_token = torch.multinomial(probs, num_samples=1)
            generated_ids = torch.cat([generated_ids, next_token], dim=1)

            tok = int(next_token.view(-1)[0])
            if tok == t3.hp.stop_speech_token:
                break
            if tok < SPEECH_VOCAB_SIZE:      # same filter generate() applies at the end
                yield tok

            next_embed = t3.speech_emb(next_token) + t3.speech_pos_emb.get_fixed_embedding(i + 1)
            if use_cfg:
                next_embed = torch.cat([next_embed, next_embed])
            output = t3.patched_model(inputs_embeds=next_embed, past_key_values=past,
                                      output_attentions=True, output_hidden_states=True,
                                      return_dict=True)
            past = output.past_key_values


class S3GenStreamer:
    """Windowed native vocoder: tokens in (cumulative), float32 audio chunks out.

    feed(tokens, finalize) vocodes when the un-emitted span reaches
    `step_tokens` (or on finalize) and returns the next audio chunk (np.float32,
    model sample rate) or None. All emissions concatenated == one continuous
    stream; the final 10 ms is flushed by the finalize call.
    """

    def __init__(self, s3gen, ref_dict: dict, sr: int, config: StreamConfig = None,
                 device=None):
        self.s3gen = s3gen
        self.ref_dict = dict(ref_dict)
        self.sr = sr
        self.cfg = config or StreamConfig()
        self.device = device if device is not None else next(s3gen.parameters()).device
        flow = s3gen.flow
        self.ratio = getattr(flow, "token_mel_ratio", 2)
        self.cfg.holdback_tokens = max(self.cfg.holdback_tokens,
                                       getattr(flow, "pre_lookahead_len", 3))
        self.mel_len1 = self.ref_dict["prompt_feat"].shape[1]
        gen = torch.Generator(device="cpu")
        if self.cfg.noise_seed is not None:
            gen.manual_seed(self.cfg.noise_seed)
        # Pinned per-request noise for the decoder: prefix slices are identical
        # across growing calls, which is what keeps trajectories near-stable.
        self.noise_full = torch.randn(
            1, 80, self.mel_len1 + self.ratio * self.cfg.max_new_tokens,
            generator=gen).to(device=self.device, dtype=torch.float32)

        self._emitted_frames = 0     # mel frames already vocoded+released
        self._last_vocoded_k = 0     # token count at the last vocode call
        self._prev_tail_mel = None   # last overlap_frames of emitted mels; None until
                                     # the first emission (doubles as the "has emitted"
                                     # flag for the first-vs-later holdback choice)
        self._prev_tail_src = None   # their HiFi-GAN excitation (phase cache)
        self._spf = None             # samples per mel frame (measured on call 1)
        self._held_tail = None       # final wave_xfade_s of audio not yet released
        self.finalized = False

    # -- internals ------------------------------------------------------------

    def _flow_prefix(self, tokens: torch.Tensor) -> torch.Tensor:
        """Mels for the whole prefix (ours only; voice prompt cropped by flow)."""
        from chatterbox.models.s3gen.s3gen import S3Token2Mel
        k = tokens.numel()
        nm = self.noise_full[:, :, :self.mel_len1 + self.ratio * k]
        with torch.inference_mode():
            return S3Token2Mel.forward(
                self.s3gen, speech_tokens=tokens,
                ref_wav=None, ref_sr=None, ref_dict=dict(self.ref_dict),
                finalize=True,               # pinned finalize=False path is buggy;
                noised_mels=nm,              # lookahead is our holdback instead
                n_cfm_timesteps=self.cfg.n_cfm_timesteps,
            )

    # -- API --------------------------------------------------------------------

    def feed(self, tokens: torch.Tensor, finalize: bool = False) -> Optional[np.ndarray]:
        """Advance the stream with the cumulative token prefix. Returns the next
        audio chunk, or None if not enough new tokens have accumulated yet."""
        assert not self.finalized, "stream already finalized"
        k = int(tokens.numel())
        if not finalize and k - self._last_vocoded_k < self.cfg.step_tokens:
            return None
        holdback = 0 if finalize else (
            self.cfg.holdback_tokens if self._prev_tail_mel is not None
            else self.cfg.first_holdback_tokens)
        usable = self.ratio * max(k - holdback, 0)
        if finalize:
            self.finalized = True
        if usable <= self._emitted_frames:
            return self._flush_tail() if finalize else None

        mels = self._flow_prefix(tokens)
        usable = min(usable, mels.shape[2])
        c = self.cfg
        if self._prev_tail_mel is not None:
            ovl = self._prev_tail_mel.shape[2]
            alpha = torch.linspace(0.0, 1.0, ovl, device=mels.device).view(1, 1, -1)
            re_tail = mels[:, :, self._emitted_frames - ovl:self._emitted_frames]
            blended = self._prev_tail_mel * (1.0 - alpha) + re_tail * alpha
            feed = torch.cat([blended, mels[:, :, self._emitted_frames:usable]], dim=2)
            cache = self._prev_tail_src
        else:
            ovl = 0
            feed = mels[:, :, :usable]
            cache = torch.zeros(1, 1, 0, device=self.device)

        with torch.inference_mode():
            wav, src = self.s3gen.hift_inference(feed, cache_source=cache)
        if self._spf is None:
            self._spf = wav.shape[-1] // feed.shape[2]

        wav = wav.squeeze(0).float().cpu().numpy()
        fx = int(c.wave_xfade_s * self.sr)
        if ovl:
            ovl_samples = ovl * self._spf
            wav_overlap, wav_new = wav[:ovl_samples], wav[ovl_samples:]
            # Blend the held tail (already-vocoded audio we did NOT release yet)
            # into the re-rendered overlap, then prepend it to this emission.
            head = self._held_tail
            n = min(len(head), len(wav_overlap))
            if n > 0:
                a = 0.5 * (1 - np.cos(np.linspace(0, np.pi, n)))
                head = head[:n] * (1 - a) + wav_overlap[-n:] * a
            out = np.concatenate([head, wav_new])
        else:
            out = wav

        keep = min(c.overlap_frames, usable)
        self._prev_tail_mel = mels[:, :, usable - keep:usable]
        self._prev_tail_src = src[:, :, -keep * self._spf:]
        self._emitted_frames = usable
        self._last_vocoded_k = k

        if finalize:
            self._held_tail = None
            return out.astype(np.float32)
        self._held_tail = out[-fx:] if fx and len(out) > fx else np.zeros(0, np.float32)
        return out[:-fx].astype(np.float32) if fx and len(out) > fx else out.astype(np.float32)

    def _flush_tail(self) -> Optional[np.ndarray]:
        tail, self._held_tail = self._held_tail, None
        return tail.astype(np.float32) if tail is not None and len(tail) else None


def generate_stream(model, text: str, *, audio_prompt_path: Optional[str] = None,
                    exaggeration: float = 0.5, cfg_weight: float = 0.5,
                    temperature: float = 0.8,
                    config: StreamConfig = None) -> Generator[np.ndarray, None, None]:
    """Stream TTS: yields float32 mono chunks at model.sr as they render.
    Voice/params semantics mirror ChatterboxTTS.generate().

    `audio_prompt_path` loads server-side voice conditionals lazily. Satellite
    callers provide cached `model.conds` and pass `None`, so keep the `tts_utils`
    import inside this branch to preserve standalone satellite imports.
    """
    cfg = config or StreamConfig()
    if audio_prompt_path:
        # Chatterbox opens this path directly, so callers must resolve it through
        # the shared voice helper before preparing conditionals.
        from tts_utils import voice_for_model
        model.prepare_conditionals(voice_for_model(audio_prompt_path), exaggeration=exaggeration)
    else:
        assert model.conds is not None, "prepare_conditionals first or pass audio_prompt_path"

    streamer = S3GenStreamer(model.s3gen, model.conds.gen, model.sr, cfg)
    buf, last_fed = [], 0
    for tok in stream_speech_tokens(model, text, exaggeration=exaggeration,
                                    cfg_weight=cfg_weight, temperature=temperature,
                                    max_new_tokens=cfg.max_new_tokens):
        buf.append(tok)
        if len(buf) - last_fed >= cfg.step_tokens:
            last_fed = len(buf)
            chunk = streamer.feed(torch.tensor([buf], dtype=torch.long,
                                               device=model.device))
            if chunk is not None and len(chunk):
                yield chunk
    if buf:
        chunk = streamer.feed(torch.tensor([buf], dtype=torch.long,
                                           device=model.device), finalize=True)
        if chunk is not None and len(chunk):
            yield chunk
