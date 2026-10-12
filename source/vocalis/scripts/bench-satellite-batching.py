"""Proof-of-concept bench for the Vocalis satellite batching proposal.

Answers the open questions in the satellite batching design document using the target GPU and
Chatterbox 0.1.7 installation:

  baseline  §6  single-stream realtime multiple + the T3/S3Gen/watermark split
  vram      §4  per-replica VRAM at 0, 1, 2 replicas
  two       §2  two-concurrent aggregate (the 1.45x claim)
  micro     §5  ms/decode-step vs batch size -- the physics, measured not assumed
  batched   §5  a real batched decode end to end
  vramgrid  §5  peak VRAM over batch size x CHUNK LENGTH, with the physical variables

Run one subcommand per process; the model load is 30-60 s and VRAM numbers are
only honest in a fresh process.

    venv\\Scripts\\python.exe poc.py baseline
"""
import argparse
import os
import statistics
import sys
import threading
import time

import numpy as np
import torch

# The satellite's own batch module, so this harness certifies the code that SHIPS rather than a
# copy of it that can drift. Also brings the VRAM watchdog — see cmd_vrambatch.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "satellite"))
import vocalis_satellite_batch as sat                        # noqa: E402


# ── the workload ──────────────────────────────────────────────────────────────
# Vocalis splits at CHUNK_SIZE = 400 chars on sentence boundaries (tts_utils.py:78),
# so a representative chunk is 250-400 chars of ordinary prose. These four are
# deliberately different lengths -- padding waste is part of what we are measuring.
CHUNKS = [
    "The satellite protocol was never meant to carry anything but text and a voice hash, "
    "which is why the whole thing fits in a single file. Every render arrives, does its work "
    "on one card, and goes home again without leaving a trace on the disk.",

    "She had been staring at the same paragraph for twenty minutes, and the words had long "
    "since stopped meaning anything at all. Outside, the rain kept up its steady argument "
    "with the window, and somewhere below a door closed twice.",

    "There is a particular kind of silence that settles over a machine room at four in the "
    "morning, when the last job has drained out of the queue and the fans finally spin down "
    "to idle. It never lasts, but it is worth staying up for.",

    "He counted the steps down to the landing out of habit, the way he had every night for "
    "eleven years, and was faintly annoyed to find there were still thirteen of them.",
]

TEXT = CHUNKS[0]
DEVICE = "cuda:0"


def gb(x):
    return x / 1024 ** 3


def vram():
    """(free, total) on the device, GB -- the whole card, not just this process."""
    free, total = torch.cuda.mem_get_info(0)
    return gb(free), gb(total)


def report_vram(label):
    free, total = vram()
    print(f"  [vram] {label:<28} device free {free:6.2f} / {total:.2f} GB | "
          f"torch allocated {gb(torch.cuda.memory_allocated()):5.2f} "
          f"reserved {gb(torch.cuda.memory_reserved()):5.2f} "
          f"peak-alloc {gb(torch.cuda.max_memory_allocated()):5.2f} GB")


def load_model(device=DEVICE):
    from chatterbox.tts import ChatterboxTTS
    t0 = time.time()
    m = ChatterboxTTS.from_pretrained(device=device)
    print(f"  loaded in {time.time() - t0:.1f}s  sr={m.sr}  conds={'yes' if m.conds else 'NO'}")
    return m


class Stages:
    """Wall-clock per stage of one render, by wrapping the three real call sites."""

    def __init__(self, model):
        self.model = model
        self.t = {}
        self._orig = {}

    def __enter__(self):
        self.t = {"t3": 0.0, "s3gen": 0.0, "watermark": 0.0, "tokens": 0}
        m = self.model

        def wrap(obj, name, key, count_tokens=False):
            orig = getattr(obj, name)
            self._orig[(obj, name)] = orig

            def inner(*a, **kw):
                torch.cuda.synchronize()
                t0 = time.time()
                out = orig(*a, **kw)
                torch.cuda.synchronize()
                self.t[key] += time.time() - t0
                if count_tokens:
                    self.t["tokens"] = int(out.shape[-1])
                return out
            setattr(obj, name, inner)

        wrap(m.t3, "inference", "t3", count_tokens=True)
        wrap(m.s3gen, "inference", "s3gen")
        wrap(m.watermarker, "apply_watermark", "watermark")
        return self

    def __exit__(self, *exc):
        for (obj, name), orig in self._orig.items():
            setattr(obj, name, orig)
        self._orig.clear()
        return False


def render(model, text, seed=None):
    if seed is not None:
        torch.manual_seed(seed)
    torch.cuda.synchronize()
    t0 = time.time()
    wav = model.generate(text, exaggeration=0.5, cfg_weight=0.5, temperature=0.8)
    torch.cuda.synchronize()
    dt = time.time() - t0
    audio_s = wav.shape[-1] / model.sr
    return audio_s, dt


# ── baseline ──────────────────────────────────────────────────────────────────

def cmd_baseline(args):
    print("== single-stream baseline on one 4090, nothing else rendering ==")
    report_vram("before load")
    model = load_model()
    report_vram("model resident, 0 renders")

    print("\n  warm-up render (discarded)")
    render(model, TEXT, seed=1)
    report_vram("after 1 render")

    rows = []
    for i in range(args.runs):
        with Stages(model) as st:
            audio_s, dt = render(model, TEXT, seed=100 + i)
        rtf = audio_s / dt
        rows.append((audio_s, dt, rtf, dict(st.t)))
        s = st.t
        other = dt - s["t3"] - s["s3gen"] - s["watermark"]
        print(f"  run {i+1}: {audio_s:5.2f}s audio in {dt:5.2f}s = {rtf:.3f}x realtime"
              f"   | t3 {s['t3']:5.2f}s ({100*s['t3']/dt:4.1f}%)"
              f"  s3gen {s['s3gen']:5.2f}s ({100*s['s3gen']/dt:4.1f}%)"
              f"  wm {s['watermark']:4.2f}s ({100*s['watermark']/dt:4.1f}%)"
              f"  other {other:4.2f}s"
              f"  | {s['tokens']} speech tokens")

    rtfs = [r[2] for r in rows]
    t3_share = statistics.mean(r[3]["t3"] / r[1] for r in rows)
    print(f"\n  MEDIAN single-stream: {statistics.median(rtfs):.3f}x realtime "
          f"(n={len(rtfs)}, spread {min(rtfs):.3f}-{max(rtfs):.3f})")
    print(f"  T3 decode owns {100*t3_share:.1f}% of wall time -- that is the Amdahl ceiling "
          f"on batching T3 alone")
    report_vram("end")


# ── vram ──────────────────────────────────────────────────────────────────────

def cmd_vram(args):
    print("== per-replica VRAM, the 5-7 GB anomaly (upgrade doc s4) ==")
    report_vram("0 replicas (desktop only)")
    free0, _ = vram()

    models = []
    prev = free0
    for n in range(1, args.replicas + 1):
        models.append(load_model())
        report_vram(f"{n} replica(s) loaded")
        free, _ = vram()
        print(f"    -> replica {n}: +{prev - free:.2f} GB this one, "
              f"{free0 - free:.2f} GB cumulative")
        prev = free

    print("\n  now render once on each replica -- allocator peak is what actually has to fit")
    for i, m in enumerate(models):
        render(m, TEXT, seed=7)
        report_vram(f"after render on replica {i+1}")

    free_end, total = vram()
    print(f"\n  device free at end: {free_end:.2f} / {total:.2f} GB with "
          f"{len(models)} replicas resident and each having rendered once "
          f"({free0 - free_end:.2f} GB total cost for {len(models)})")


# ── two concurrent ────────────────────────────────────────────────────────────

def cmd_two(args):
    n = args.workers
    print(f"== {n} concurrent workers on one 4090 (the 1.45x claim) ==")
    report_vram("before load")
    models = [load_model() for _ in range(n)]
    report_vram(f"{n} replicas resident")

    for m in models:                      # warm each
        render(m, TEXT, seed=1)
    report_vram(f"{n} replicas, each warmed")

    per = args.each
    results = [None] * n

    def worker(idx):
        model = models[idx]
        audio = 0.0
        t0 = time.time()
        for k in range(per):
            a, _ = render(model, CHUNKS[k % len(CHUNKS)], seed=200 + idx * 10 + k)
            audio += a
        results[idx] = (audio, time.time() - t0)

    torch.cuda.synchronize()
    wall0 = time.time()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.time() - wall0

    total_audio = sum(r[0] for r in results)
    for i, (a, d) in enumerate(results):
        print(f"  worker {i}: {a:6.2f}s audio in {d:6.2f}s = {a/d:.3f}x realtime (per-stream)")
    print(f"\n  AGGREGATE: {total_audio:.2f}s audio in {wall:.2f}s wall = "
          f"{total_audio/wall:.3f}x realtime across {n} workers")
    report_vram("end")

    # same work, one worker at a time, for an apples-to-apples serial control
    if args.control:
        print("\n  serial control: same chunks, one at a time, one replica")
        audio = 0.0
        t0 = time.time()
        for i in range(n):
            for k in range(per):
                a, _ = render(models[0], CHUNKS[k % len(CHUNKS)], seed=200 + i * 10 + k)
                audio += a
        d = time.time() - t0
        print(f"  SERIAL: {audio:.2f}s audio in {d:.2f}s = {audio/d:.3f}x realtime")


# ── micro: the physics ────────────────────────────────────────────────────────

def cmd_micro(args):
    """Time one decode step of the real T3 backbone vs batch size.

    This is the whole proposal in one number. The decode loop in
    chatterbox/models/t3/t3.py already runs at batch 2 (CFG cond+uncond), so
    batch 2 IS today's cost of one sequence. If batch 8 costs about what batch 2
    costs, four sequences ride for the price of one and batching wins. If it
    costs 4x, the decode is compute-bound at these sizes and the idea is dead.
    """
    print("== decode-step cost vs batch size (the load-bearing measurement) ==")
    model = load_model()
    report_vram("model resident")

    # Build patched_model + a realistic prefix by doing one real render.
    render(model, TEXT, seed=1)
    t3 = model.t3
    pm = t3.patched_model
    dim = t3.cfg.hidden_size
    device = torch.device(DEVICE)
    dtype = next(pm.parameters()).dtype
    print(f"  backbone: hidden={dim} layers={t3.cfg.num_hidden_layers} dtype={dtype}")

    prefix_len = args.prefix
    steps = args.steps

    def bench(batch, output_attentions):
        pm._added_cond = True
        embeds = torch.randn(batch, prefix_len, dim, device=device, dtype=dtype)
        with torch.inference_mode():
            out = pm(inputs_embeds=embeds, past_key_values=None, use_cache=True,
                     output_attentions=output_attentions, output_hidden_states=True,
                     return_dict=True)
            past = out.past_key_values
            step_embed = torch.randn(batch, 1, dim, device=device, dtype=dtype)
            for _ in range(5):                      # warm
                out = pm(inputs_embeds=step_embed, past_key_values=past,
                         output_attentions=output_attentions, output_hidden_states=True,
                         return_dict=True)
                past = out.past_key_values
            torch.cuda.synchronize()
            t0 = time.time()
            for _ in range(steps):
                out = pm(inputs_embeds=step_embed, past_key_values=past,
                         output_attentions=output_attentions, output_hidden_states=True,
                         return_dict=True)
                past = out.past_key_values
            torch.cuda.synchronize()
            dt = time.time() - t0
        del past, out, embeds, step_embed
        torch.cuda.empty_cache()
        return dt / steps * 1000.0

    print(f"\n  prefix {prefix_len} tokens, {steps} timed decode steps per point")
    print(f"  {'batch':>6} {'seqs':>5} {'ms/step':>9} {'ms/seq':>8} {'vs b=2':>8}  "
          f"{'output_attentions=True':>24}")
    base = None
    base_oa = None
    for batch in args.batches:
        ms = bench(batch, False)
        ms_oa = bench(batch, True)
        if base is None:
            base, base_oa = ms, ms_oa
        seqs = batch // 2
        print(f"  {batch:>6} {seqs:>5} {ms:9.3f} {ms/max(seqs,1):8.3f} {ms/base:7.2f}x  "
              f"{ms_oa:20.3f} ms  ({ms_oa/ms:.2f}x)")

    print("\n  read it like this: 'ms/seq' is the per-sequence cost of a decode step.")
    print("  Flat ms/step across batch sizes => memory-bandwidth-bound, batching is free.")
    print("  ms/step rising linearly => compute-bound, batching buys nothing.")


# ── batched end to end ────────────────────────────────────────────────────────

def batched_t3(t3, t3_cond, text_token_rows, *, max_new_tokens=1000, temperature=0.8,
               cfg_weight=0.5, repetition_penalty=1.2, min_p=0.05, top_p=1.0):
    """T3.inference for N sequences in one forward pass. Batch is 2N (CFG).

    Mirrors chatterbox/models/t3/t3.py's loop exactly except that the CFG combine,
    the sampler and the EOS check all work per sequence instead of on rows 0 and 1.
    Text rows are LEFT-padded so every sequence's text ends where its speech starts;
    the pad positions are masked out of attention.

    Returns list[LongTensor] -- one token sequence per input, each cut at its own EOS.
    """
    # The whole body, prep included. `prepare_input_embeds` runs the perceiver over
    # `conds.t3.cond_prompt_speech_tokens`, which prepare_conditionals created inside
    # inference_mode -- touching an inference tensor outside one raises "Inference
    # tensors cannot be saved for backward" from a layer_norm. T3.inference has the
    # same structure for the same reason.
    with torch.inference_mode():
        return _batched_t3(t3, t3_cond, text_token_rows, max_new_tokens=max_new_tokens,
                           temperature=temperature, cfg_weight=cfg_weight,
                           repetition_penalty=repetition_penalty, min_p=min_p, top_p=top_p)


def _batched_t3(t3, t3_cond, text_token_rows, *, max_new_tokens, temperature,
                cfg_weight, repetition_penalty, min_p, top_p):
    from transformers.generation.logits_process import (MinPLogitsWarper,
                                                        RepetitionPenaltyLogitsProcessor,
                                                        TopPLogitsWarper)
    device = t3.device
    n = len(text_token_rows)
    lmax = max(r.numel() for r in text_token_rows)

    # ── embeddings, built the way prepare_input_embeds builds them ──────────────
    # Not by calling it: it zeroes the CFG uncond row BEFORE adding the learned
    # positional embedding (`text_emb[1].zero_()` then `+ text_pos_emb`), so zeroing
    # the finished slice afterward would also wipe the positions and is NOT the same
    # thing. And the learned text positions must be 0..len-1 per row, which means
    # embedding each row unpadded and left-padding the RESULT -- pad first and every
    # short chunk gets its whole text shifted to positions it was never trained on.
    cond_emb = t3.prepare_conditioning(t3_cond)               # (1, len_cond, dim)
    len_cond = cond_emb.size(1)
    dim = cond_emb.size(-1)
    learned = t3.hp.input_pos_emb == "learned"

    text_emb = torch.zeros((2 * n, lmax, dim), device=device, dtype=cond_emb.dtype)
    text_mask = torch.zeros((n, lmax), dtype=torch.long, device=device)
    for i, row in enumerate(text_token_rows):
        row = row.to(device).unsqueeze(0)                     # (1, len)
        e = t3.text_emb(row)                                  # (1, len, dim)
        cond_e = e + t3.text_pos_emb(row) if learned else e
        # CFG uncond: token embedding blanked, positions kept -- exactly what
        # prepare_input_embeds does to row 1 of a batch of 2.
        z = torch.zeros_like(e)
        uncond_e = z + t3.text_pos_emb(row) if learned else z
        L = row.size(1)
        text_emb[i, lmax - L:] = cond_e[0]                    # LEFT pad
        text_emb[n + i, lmax - L:] = uncond_e[0]
        text_mask[i, lmax - L:] = 1

    speech_tokens = torch.full((2 * n, 1), t3.hp.start_speech_token,
                               dtype=torch.long, device=device)
    speech_emb = t3.speech_emb(speech_tokens)
    if learned:
        speech_emb = speech_emb + t3.speech_pos_emb(speech_tokens)
    embeds = torch.cat([cond_emb.expand(2 * n, -1, -1), text_emb, speech_emb], dim=1)

    pm = t3.patched_model
    pm._added_cond = True
    bos = torch.full((2 * n, 1), t3.hp.start_speech_token, dtype=torch.long, device=device)
    bos_embed = t3.speech_emb(bos) + t3.speech_pos_emb.get_fixed_embedding(0)
    inputs_embeds = torch.cat([embeds, bos_embed], dim=1)

    rep_proc = RepetitionPenaltyLogitsProcessor(penalty=float(repetition_penalty))
    min_p_warp = MinPLogitsWarper(min_p=min_p)
    top_p_warp = TopPLogitsWarper(top_p=top_p)

    generated = bos[:n].clone()                               # (N, 1) cond half only
    predicted = []
    finished = torch.zeros(n, dtype=torch.bool, device=device)
    stop = t3.hp.stop_speech_token

    # The left pads have to be masked OUT of attention, and T3HuggingfaceBackend.forward
    # takes no attention_mask -- it forwards a fixed argument list to the LlamaModel. So
    # call the LlamaModel and the speech head directly, which is all its forward does.
    # Without this the pad positions are attended as zero vectors: harmless-looking, and
    # it silently makes a short chunk's output depend on how long its batch partners were.
    pre = torch.ones((2 * n, len_cond), dtype=torch.long, device=device)
    post = torch.ones((2 * n, inputs_embeds.size(1) - len_cond - lmax),
                      dtype=torch.long, device=device)
    mask = torch.cat([pre, text_mask.repeat(2, 1), post], dim=1)

    def step(embs, past_kv):
        tfmr = pm.model(inputs_embeds=embs, attention_mask=mask, past_key_values=past_kv,
                        use_cache=True, output_hidden_states=True, return_dict=True)
        return pm.speech_head(tfmr.hidden_states[-1]), tfmr.past_key_values

    with torch.inference_mode():
        logits_all, past = step(inputs_embeds, None)
        for i in range(max_new_tokens):
            logits_step = logits_all[:, -1, :]
            cond, uncond = logits_step[:n], logits_step[n:]
            logits = cond + cfg_weight * (cond - uncond)      # (N, V)
            logits = rep_proc(generated, logits)
            if temperature != 1.0:
                logits = logits / temperature
            logits = min_p_warp(generated, logits)
            logits = top_p_warp(generated, logits)
            nxt = torch.multinomial(torch.softmax(logits, dim=-1), num_samples=1)  # (N,1)
            # A finished sequence keeps emitting its stop token; it is trimmed at the end.
            nxt = torch.where(finished.unsqueeze(1), torch.full_like(nxt, stop), nxt)
            predicted.append(nxt)
            generated = torch.cat([generated, nxt], dim=1)
            finished |= (nxt.squeeze(1) == stop)
            if bool(finished.all()):
                break
            emb = t3.speech_emb(nxt) + t3.speech_pos_emb.get_fixed_embedding(i + 1)
            emb = torch.cat([emb, emb], dim=0)                # (2N, 1, dim)
            mask = torch.cat([mask, torch.ones((2 * n, 1), dtype=torch.long,
                                               device=device)], dim=1)
            logits_all, past = step(emb, past)

    toks = torch.cat(predicted, dim=1)                        # (N, steps)
    rows = []
    for i in range(n):
        row = toks[i]
        hit = (row == stop).nonzero()
        rows.append(row[:hit[0, 0]] if hit.numel() else row)
    return rows, toks.shape[1]


def _text_tokens(model, text):
    """Exactly what ChatterboxTTS.generate does to text, minus the CFG duplication."""
    import torch.nn.functional as F
    from chatterbox.tts import punc_norm
    t = model.tokenizer.text_to_tokens(punc_norm(text)).to(model.device)
    t = F.pad(t, (1, 0), value=model.t3.hp.start_text_token)
    t = F.pad(t, (0, 1), value=model.t3.hp.stop_text_token)
    return t[0]


def _vocode(model, speech_tokens):
    """The tail of ChatterboxTTS.generate: drop invalid tokens, s3gen, watermark."""
    from chatterbox.models.s3tokenizer import drop_invalid_tokens
    with torch.inference_mode():
        st = drop_invalid_tokens(speech_tokens)
        st = st[st < 6561].to(model.device)
        wav, _ = model.s3gen.inference(speech_tokens=st, ref_dict=model.conds.gen)
        wav = wav.squeeze(0).detach().cpu().numpy()
        return model.watermarker.apply_watermark(wav, sample_rate=model.sr)


def cmd_batched(args):
    print("== batched decode end to end vs the same chunks rendered one at a time ==")
    model = load_model()
    report_vram("model resident")
    render(model, TEXT, seed=1)                               # build patched_model, warm

    texts = (CHUNKS * 4)[:args.n]
    rows = [_text_tokens(model, t) for t in texts]
    print(f"  {len(texts)} chunks, text token lengths {[r.numel() for r in rows]}")

    def serial_arm(label):
        """Today's path: one chunk at a time on one replica.

        Run TWICE, before and after the batched arm. The 4090 loses clock under
        sustained load, so a single serial arm measured first would flatter the
        batched arm that follows it; two bracket it and the drift becomes visible
        instead of being silently folded into the speedup.
        """
        torch.cuda.reset_peak_memory_stats()
        torch.manual_seed(500)
        torch.cuda.synchronize()
        t0 = time.time()
        audio, wavs_, lens_ = 0.0, [], []
        for t in texts:
            with Stages(model) as st:
                wav = model.generate(t, exaggeration=0.5, cfg_weight=0.5, temperature=0.8)
            lens_.append(st.t["tokens"])
            wavs_.append(wav.squeeze(0).numpy())
            audio += wav.shape[-1] / model.sr
        torch.cuda.synchronize()
        dt = time.time() - t0
        peak = gb(torch.cuda.max_memory_allocated())
        tok = sum(lens_)
        print(f"\n  {label:<9}: {audio:6.2f}s audio in {dt:6.2f}s = "
              f"{audio/dt:.3f}x realtime   peak-alloc {peak:.2f} GB")
        print(f"             {tok} speech tokens -> {tok/dt:6.1f} tokens/s")
        return audio, dt, peak, tok, wavs_

    serial_audio, serial_dt, serial_peak, serial_tok, serial_wavs = serial_arm("SERIAL")

    # --- batched: one T3 pass for all N, then vocode each ---
    torch.cuda.reset_peak_memory_stats()
    torch.manual_seed(500)
    torch.cuda.synchronize()
    t0 = time.time()
    tok_rows, steps = batched_t3(model.t3, model.conds.t3, rows,
                                 temperature=0.8, cfg_weight=0.5)
    torch.cuda.synchronize()
    t3_dt = time.time() - t0
    batch_audio = 0.0
    wavs = []
    for r in tok_rows:
        w = _vocode(model, r)
        wavs.append(w)
        batch_audio += len(w) / model.sr
    torch.cuda.synchronize()
    total_dt = time.time() - t0
    batch_peak = gb(torch.cuda.max_memory_allocated())

    lens = [r.numel() for r in tok_rows]
    batch_tok = sum(lens)
    waste = 1.0 - (batch_tok / (steps * len(lens)))
    print(f"  BATCHED  : {batch_audio:6.2f}s audio in {total_dt:6.2f}s = "
          f"{batch_audio/total_dt:.3f}x realtime   peak-alloc {batch_peak:.2f} GB")
    print(f"             {batch_tok} speech tokens -> {batch_tok/total_dt:6.1f} tokens/s")
    print(f"             t3 {t3_dt:.2f}s of that ({100*t3_dt/total_dt:.1f}%), "
          f"vocode+watermark {total_dt-t3_dt:.2f}s (still serial, one chunk at a time)")
    print(f"             tokens per chunk {lens}, batch ran {steps} steps "
          f"-> {100*waste:.1f}% padding waste in the token dimension")

    # Sampling is stochastic, so the two arms make different amounts of audio from the
    # same text. tokens/s is the metric that does not care; the realtime ratio agrees
    # with it exactly because speech tokens are a fixed 25 Hz.
    # The bracketing control: same work, same process, after the batched arm.
    s2_audio, s2_dt, _, s2_tok, _ = serial_arm("SERIAL-2")
    drift = (s2_tok / s2_dt) / (serial_tok / serial_dt)
    # TWO-SIDED. This read `drift < 0.95` and called everything else "stable", so an
    # R9700 run whose two identical serial arms came in 67.95s and 45.42s apart was
    # reported as stable at 1.50x. Drift upward is the MORE alarming direction here --
    # it means the earlier arm was still paying MIOpen kernel compilation, so the
    # baseline it establishes is too slow and every speedup measured against it is
    # inflated. A control that only fails in one direction is not a control.
    if drift < 0.95:
        why = "SUSPECT - clock loss under sustained load, later arms handicapped"
    elif drift > 1.05:
        why = "SUSPECT - earlier arm was still warming, speedups vs it are INFLATED"
    else:
        why = "stable"
    print(f"             drift vs the first serial arm: {drift:.2f}x ({why})")
    if not 0.95 <= drift <= 1.05:
        # ASCII, not an emoji: this file's stdout is routinely piped (see the `| tail` in the
        # sweep notes), and U+1F534 is not representable in cp1252 — so the one branch that
        # fires when a run must be DISCARDED was the one that killed the process with
        # UnicodeEncodeError, taking the correctness asserts and the number with it.
        print(f"             *** the two controls disagree by {abs(1-drift)*100:.0f}% on "
              f"identical work -- treat every ratio below as unreliable")

    serial_rate = min(serial_tok / serial_dt, s2_tok / s2_dt)   # the arm that flatters batching least
    best_serial = max(serial_tok / serial_dt, s2_tok / s2_dt)
    batch_rate = batch_tok / total_dt
    print(f"\n  SPEEDUP  : {batch_rate/best_serial:.2f}x on decode throughput (tokens/s) "
          f"against the BEST serial arm, {batch_rate/serial_rate:.2f}x against the worst")
    print(f"             one replica, +{batch_peak-serial_peak:.2f} GB peak, "
          f"wall clock {serial_dt:.2f}s -> {total_dt:.2f}s for these {len(texts)} chunks")

    if args.save:
        import soundfile as sf
        import os
        os.makedirs("wav", exist_ok=True)
        for i, (sw, bw) in enumerate(zip(serial_wavs, wavs)):
            sf.write(f"wav/{i}_serial.wav", sw, model.sr)
            sf.write(f"wav/{i}_batched.wav", bw, model.sr)
        print(f"\n  wrote {2*len(wavs)} wavs to temp/batching-poc/wav/ -- same text, "
              f"same voice, one rendered each way. Listen before believing the numbers.")


# ── dtype ─────────────────────────────────────────────────────────────────────

def cmd_dtype(args):
    """Compare satellite fp32 rendering with the desktop's bf16 autocast path.

    `tts_utils._autocast_ctx()` applies VOCALIS_DTYPE during desktop generation, while the
    satellite render and stream paths do not apply autocast. This benchmark measures the
    throughput and memory difference for the same model.
    """
    import contextlib
    print("== satellite fp32 vs desktop bf16 autocast ==")
    model = load_model()
    render(model, TEXT, seed=1)                               # warm

    def run(label, ctx_fn, runs=3):
        rows = []
        for i in range(runs):
            with ctx_fn():
                with Stages(model) as st:
                    audio_s, dt = render(model, TEXT, seed=100 + i)
            rows.append((audio_s / dt, st.t["t3"], st.t["s3gen"], st.t["tokens"]))
        rtf = statistics.median(r[0] for r in rows)
        print(f"  {label:<26} median {rtf:.3f}x realtime   "
              f"t3 {statistics.median(r[1] for r in rows):5.2f}s  "
              f"s3gen {statistics.median(r[2] for r in rows):4.2f}s  "
              f"peak-alloc {gb(torch.cuda.max_memory_allocated()):.2f} GB")
        return rtf

    torch.cuda.reset_peak_memory_stats()
    fp32 = run("fp32 (satellite today)", contextlib.nullcontext)
    torch.cuda.reset_peak_memory_stats()
    bf16 = run("bf16 autocast (desktop path)",
               lambda: torch.autocast("cuda", dtype=torch.bfloat16))
    print(f"\n  bf16 autocast is {bf16/fp32:.2f}x the fp32 rate "
          f"({100*(bf16/fp32-1):+.1f}%) for a one-line change")


# ── batched vocoder ───────────────────────────────────────────────────────────

SAMPLES_PER_TOKEN = 960          # 24 kHz / 25 Hz speech-token rate; checked against serial output


def _vocode_batched(model, token_rows):
    """Vocode N token sequences in ONE S3Gen pass. Returns list[np.ndarray].

    `S3Token2Mel.forward` already takes `speech_token_lens` and the flow is written for a
    batch dimension (`_repeat_batch_dim`, `token: (B, n_toks)`), so this needs no patching --
    unlike T3, which had to be reimplemented. RIGHT padding is the correct choice here: the
    flow prepends the reference prompt and builds its mask from `prompt_len + real_len`, so
    trailing pads land exactly in the masked region.
    """
    from chatterbox.models.s3tokenizer import drop_invalid_tokens
    with torch.inference_mode():
        rows = []
        for r in token_rows:
            r = drop_invalid_tokens(r)
            rows.append(r[r < 6561].to(model.device))
        lens = [r.numel() for r in rows]
        lmax = max(lens)
        padded = torch.zeros((len(rows), lmax), dtype=torch.long, device=model.device)
        for i, r in enumerate(rows):
            padded[i, :r.numel()] = r
        lens_t = torch.LongTensor(lens).to(model.device)

        wavs, _ = model.s3gen.inference(speech_tokens=padded, ref_dict=model.conds.gen,
                                        speech_token_lens=lens_t)
        wavs = wavs.detach().cpu().numpy()
        out = []
        for i, n_tok in enumerate(lens):
            w = wavs[i][:n_tok * SAMPLES_PER_TOKEN]
            out.append(model.watermarker.apply_watermark(w, sample_rate=model.sr))
        return out


SHORT = [
    "The lighthouse had not been lit in thirty years.",
    "Then whatever is burning up there is burning alone.",
    "That is precisely what worries me about it.",
    "Bring the lamp, and mind the fourth step down.",
    "She counted thirteen, the way she always had.",
    "Nobody had come back up those stairs since spring.",
]


def cmd_vrambatch(args):
    """Measure batch memory cost by batch size using short chunks.

    The existing linear estimate did not predict an observed high-batch allocation. The cap in
    `MAX_BATCH` therefore uses the largest size measured end to end; this sweep measures
    intermediate sizes while holding sequence length short.

    Three numbers per size, because they answer different questions:
      * `mem_get_info` free — what the WHOLE CARD has left, which is what actually runs out and
        the only figure that accounts for the desktop.
      * `max_memory_allocated` — live tensors at the peak. The honest "cost of the batch".
      * `max_memory_reserved` — what the caching allocator holds. Bigger than allocated, and it
        is the one that fragments; a batch can fail with plenty "free" by this measure.

    GUARDED: refuses any size that would leave less than --reserve free, and an OOM is reported
    as the measured ceiling rather than allowed to take the desktop down again.
    """
    print(f"== batch VRAM by size, {'LONG (250-400 char)' if args.long else 'SHORT'} chunks "
          f"(§5: the bound must be empirical) ==")
    free0, total = vram()
    print(f"  card: {free0:.2f} of {total:.2f} GB free before we start "
          f"({total - free0:.2f} GB already in use by the desktop), "
          f"reserving {args.reserve:.1f} GB")
    model = load_model()
    render(model, SHORT[0], seed=1)          # builds patched_model and warms the serial shapes
    free_loaded, _ = vram()
    print(f"  replica resident: {free_loaded:.2f} GB free "
          f"({free0 - free_loaded:.2f} GB for the model itself)\n")

    print(f"  {'n':>3}  {'free before':>11}  {'free at peak':>12}  {'alloc peak':>10}  "
          f"{'reserved':>9}  {'card cost':>9}  {'per chunk':>9}")
    prev_cost = None
    for n in args.sizes:
        free_before, _ = vram()
        if free_before < args.reserve:
            print(f"  {n:>3}  SKIPPED — only {free_before:.2f} GB free, under the "
                  f"{args.reserve:.1f} GB reserve")
            break
        # The control that decides what the n=16 failure was ABOUT. The KV cache scales with
        # batch x sequence length, so if the cost is driven by length rather than by chunk count
        # then a cap expressed in CHUNKS is the wrong shape entirely.
        pool = CHUNKS if args.long else SHORT
        texts = [pool[i % len(pool)] for i in range(n)]
        rows = [_text_tokens(model, t) for t in texts]
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        free_before, _ = vram()
        try:
            torch.manual_seed(1)
            # THE SHIPPED IMPLEMENTATION, with its VRAM watchdog — not this file's own copy.
            #
            # Exercise the shipped implementation so the benchmark covers the decode and its
            # watchdog. On Windows, driver system-memory fallback can service an oversized
            # allocation instead of raising OutOfMemoryError; the watchdog samples free VRAM
            # during decode and aborts before the fallback can thrash.
            toks, _steps = sat.batched_t3(
                model.t3, model.conds.t3, rows,
                cancel=sat._vram_watchdog(DEVICE, args.abort_below, None))
            _wavs = sat.vocode_batched(model, toks)
        except sat.BatchTooBig:
            free_now, _ = vram()
            print(f"  {n:>3}  STOPPED by the watchdog — {free_before:.2f} GB free going in, "
                  f"{free_now:.2f} GB now, floor {args.abort_below:.1f} GB. "
                  f"THIS IS THE MEASURED CEILING.")
            torch.cuda.empty_cache()
            break
        except torch.cuda.OutOfMemoryError:
            # Reachable on Linux, and on a box with the sysmem fallback policy switched off.
            free_now, _ = vram()
            print(f"  {n:>3}  OUT OF MEMORY — {free_before:.2f} GB free going in, "
                  f"{free_now:.2f} GB free now. THIS IS THE MEASURED CEILING.")
            torch.cuda.empty_cache()
            break
        alloc = torch.cuda.max_memory_allocated() / 1024 ** 3
        resv = torch.cuda.max_memory_reserved() / 1024 ** 3
        free_after, _ = vram()
        cost = free_before - free_after
        per = f"{(cost / n):+.3f}" if n else "—"
        # ASCII only: this prints to a Windows console whose codec is cp1252, and a stray
        # delta symbol takes the whole run down AFTER the measurement has been made.
        delta = "" if prev_cost is None else f"  (step {cost - prev_cost:+.2f} GB)"
        print(f"  {n:>3}  {free_before:>10.2f}G  {free_after:>11.2f}G  {alloc:>9.2f}G  "
              f"{resv:>8.2f}G  {cost:>8.2f}G  {per:>9}{delta}")
        prev_cost = cost
        torch.cuda.empty_cache()

    free_end, _ = vram()
    print(f"\n  card free at end: {free_end:.2f} / {total:.2f} GB")


# ── vramgrid: the cost surface, in the variables that actually drive it ───────

# Ordinary prose to cut target-length chunks out of. Deliberately not lorem ipsum: the
# tokenizer's chars-per-token ratio is a measured input to the model fitted below, and it is
# different for real English than for pseudo-Latin.
CORPUS = (
    "The lighthouse had not been lit in thirty years and she knew it, which was the only "
    "reason the light mattered at all. Down on the shingle the tide had turned without "
    "asking anybody, and the boats that were coming in were coming in fast. He counted the "
    "steps to the landing out of habit, the way he had every night for eleven years, and was "
    "faintly annoyed to find there were still thirteen of them. There is a particular kind of "
    "silence that settles over a machine room at four in the morning, when the last job has "
    "drained out of the queue and the fans finally spin down to idle. It never lasts, but it "
    "is worth staying up for. She had been staring at the same paragraph for twenty minutes "
    "and the words had long since stopped meaning anything at all. Outside, the rain kept up "
    "its steady argument with the window, and somewhere below a door closed twice. Nobody had "
    "come back up those stairs since the spring, and nobody was going to start tonight. "
)


def _text_of_length(chars, salt=0):
    """A chunk of ordinary prose of roughly `chars` characters, ending on a word.

    `salt` rotates the starting word so that the rows of a batch are not identical strings —
    identical rows would decode in lockstep and hide the padding behavior that a real batch
    has. The LENGTH is what is being held constant, not the text.
    """
    words = CORPUS.split()
    out, n = [], 0
    i = salt % len(words)
    while n < chars:
        w = words[i % len(words)]
        out.append(w)
        n += len(w) + 1
        i += 1
    s = " ".join(out)
    return s if s.endswith(".") else s + "."


def free_gb_now():
    free, _ = vram()
    return free


def _watch_and_drop(floor_gb, drop_every):
    """The shipped VRAM watchdog, optionally releasing allocator free blocks during decode.

    Live tensors of a batched decode are predictable — 250 KiB
    per KV position, R² 0.9999 — but the CARD loses about five times that. The gap is the caching
    allocator: `DynamicCache` re-`cat`s the whole KV cache every decode step, so each step frees a
    block that the next step is already too big to reuse, and the leftovers accumulate. At
    n=16 x 182 chars the live peak was 2.84 GB and the card lost 15.93 GB.

    `expandable_segments:True` is the allocator setting written for precisely this, and it is
    **not supported on Windows** — torch 2.6.0+cu124 warns and ignores it. So the only lever left
    is handing the free blocks back periodically, which is what `drop_every` measures. It is not
    free: `cudaFree` synchronizes the device.
    """
    inner = sat._vram_watchdog(DEVICE, floor_gb, None)
    if not drop_every:
        return inner
    state = {"i": 0}

    def check():
        state["i"] += 1
        if state["i"] % drop_every == 0:
            torch.cuda.empty_cache()
        return inner()

    return check


def _geometry(model):
    """The backbone shape the KV cache is made of — printed so the fit can be checked against
    arithmetic rather than believed."""
    cfg = model.t3.cfg
    layers = int(getattr(cfg, "num_hidden_layers", 0))
    hidden = int(getattr(cfg, "hidden_size", 0))
    heads = int(getattr(cfg, "num_attention_heads", 0) or 1)
    kv_heads = int(getattr(cfg, "num_key_value_heads", 0) or heads)
    head_dim = int(getattr(cfg, "head_dim", 0) or (hidden // heads if heads else 0))
    dtype = next(model.t3.tfmr.parameters()).dtype
    bytes_per = torch.finfo(dtype).bits // 8
    # K and V, per layer, per position, for ONE row of the batch.
    per_pos_row = 2 * layers * kv_heads * head_dim * bytes_per
    return {"layers": layers, "hidden": hidden, "heads": heads, "kv_heads": kv_heads,
            "head_dim": head_dim, "dtype": str(dtype), "bytes_per_elem": bytes_per,
            "kv_bytes_per_pos_per_row": per_pos_row}


def cmd_vramgrid(args):
    """Measure batch memory cost as a function of batch size and chunk length.

    Chunk length is a dominant term. `MAX_BATCH = 8` and `GB_PER_1K_CHARS = 3.7` were
    fitted to TWO points, one of which was a lower bound (the card spilled to host RAM rather
    than raising, so nobody ever learned what that batch actually wanted). This measures the
    surface instead of a corner of it.

    The physics says the cost is a KV cache, and a KV cache is
        2 (K,V) x layers x kv_heads x head_dim x bytes  x  ROWS x POSITIONS
    where ROWS is 2N because of CFG, and POSITIONS is the conditioning prefix plus the padded
    text plus however many speech tokens got decoded. So the honest independent variable is
    `2N x (cond + text_tokens + steps)` — one number that includes both batch size and text length
    multiplied together. That is why a cap counting chunks alone can never be right.

    Every cell records the physical variables next to the GB, so the result is a fitted model
    rather than a lookup table with nothing between the rows.
    """
    import json

    free0, total = vram()
    print(f"== batch VRAM over batch size x chunk length ==")
    print(f"  card: {free0:.2f} of {total:.2f} GB free before the model loads")
    model = load_model()
    render(model, _text_of_length(80), seed=1)         # warm the serial shapes
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    baseline = gb(torch.cuda.memory_allocated())
    free_loaded, _ = vram()
    geo = _geometry(model)
    # Measured, not assumed: the conditioning prefix is speaker embedding + perceiver-resampled
    # prompt tokens + emotion, and its length is a property of the voice, not a constant anyone
    # should be typing into a bench.
    with torch.inference_mode():
        cond_len = int(model.t3.prepare_conditioning(model.conds.t3).size(1))
    geo["cond_len"] = cond_len
    print(f"  replica resident: {baseline:.2f} GB allocated, {free_loaded:.2f} GB card free")
    print(f"  conditioning prefix: {cond_len} positions (measured)")
    print(f"  backbone: {geo['layers']} layers, hidden {geo['hidden']}, "
          f"{geo['kv_heads']} kv heads x {geo['head_dim']} = "
          f"{geo['kv_bytes_per_pos_per_row']/1024:.1f} KiB of KV per position per row "
          f"({geo['dtype']})")
    print(f"  guard: abort the pass below {args.abort_below:.1f} GB free\n")

    print(f"  {'n':>3} {'chars':>6} {'ttok':>5} {'steps':>6} {'rows*pos':>9} "
          f"{'t3 GB':>7} {'s3 GB':>7} {'peak GB':>8} {'card GB':>8} "
          f"{'KiB/pos':>8} {'t3 s':>7} {'s3 s':>6} {'audio s':>8}", flush=True)
    rows_out = []

    def flush_json():
        """After EVERY cell, not at the end.

        Flush each completed cell to disk so an interrupted sweep retains its measurements.
        """
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump({"device": torch.cuda.get_device_name(0), "torch": torch.__version__,
                       "baseline_gb": round(baseline, 4), "geometry": geo,
                       "rows": rows_out}, fh, indent=1)

    for chars in args.lengths:
        for n in args.sizes:
            free_before, _ = vram()
            if free_before < args.abort_below + 1.0:
                print(f"  {n:>3} {chars:>6}  SKIPPED — only {free_before:.2f} GB free",
                      flush=True)
                continue
            texts = [_text_of_length(chars, salt=7 * i) for i in range(n)]
            rows = [sat.text_tokens(model, t) for t in texts]
            ttok = max(r.numel() for r in rows)
            torch.cuda.empty_cache()
            torch.cuda.reset_peak_memory_stats()
            torch.manual_seed(1234)
            torch.cuda.synchronize()
            t0 = time.time()
            try:
                # Exercise the shipped decode and watchdog. On Windows, driver system-memory
                # fallback may service oversized allocations instead of raising OutOfMemoryError.
                tok_rows, steps = sat.batched_t3(
                    model.t3, model.conds.t3, rows,
                    cancel=_watch_and_drop(args.abort_below, args.drop_every))
            except sat.BatchTooBig:
                free_now, _ = vram()
                print(f"  {n:>3} {chars:>6}  CEILING (T3) — watchdog stopped it "
                      f"({free_before:.2f} GB free going in, {free_now:.2f} GB at the abort)",
                      flush=True)
                torch.cuda.empty_cache()
                break                       # bigger n at this length is only worse
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                print(f"  {n:>3} {chars:>6}  CEILING (T3) — real OOM", flush=True)
                break
            torch.cuda.synchronize()
            t3_s = time.time() - t0
            t3_peak = gb(torch.cuda.max_memory_allocated()) - baseline

            # ── the vocoder, which is a SECOND peak and has NO watchdog inside it ──────────
            #
            # S3Gen.inference is a single call with no internal cancellation point. Measure it in
            # sub-batches bounded by speech-token count; --voc-tokens sets the budget under test.
            # Speech tokens, not text tokens: the vocoder pads to the longest SPEECH sequence
            # and its activations are sized by that. `ttok` is the text side and is ~5x smaller,
            # so budgeting against it would let five times too much through.
            stok = max(r.numel() for r in tok_rows) if tok_rows else 1
            budget = max(1, int(args.voc_tokens))
            per_pass = max(1, min(n, budget // max(1, stok)))
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
            t0 = time.time()
            wavs, voc_failed = [], False
            for k in range(0, n, per_pass):
                sl = tok_rows[k:k + per_pass]
                try:
                    wavs.extend(sat.vocode_batched(model, sl) if len(sl) > 1
                                else [sat.vocode_one(model, sl[0])])
                except torch.cuda.OutOfMemoryError:
                    torch.cuda.empty_cache()
                    print(f"  {n:>3} {chars:>6}  CEILING (S3Gen) — OOM vocoding "
                          f"{len(sl)} x {stok} speech tokens", flush=True)
                    voc_failed = True
                    break
                # Between sub-passes there IS a place to look, so look.
                if free_gb_now() < args.abort_below:
                    print(f"  {n:>3} {chars:>6}  CEILING (S3Gen) — {free_gb_now():.2f} GB free "
                          f"after vocoding {len(wavs)} of {n}", flush=True)
                    voc_failed = True
                    break
            if voc_failed:
                torch.cuda.empty_cache()
                break
            torch.cuda.synchronize()
            s3_s = time.time() - t0
            s3_peak = gb(torch.cuda.max_memory_allocated()) - baseline
            free_after, _ = vram()
            audio = sum(len(w) for w in wavs) / model.sr

            # `rows x positions` is the whole independent variable: 2N for CFG, and the
            # conditioning prefix plus the LEFT-PADDED text plus the decoded speech tokens.
            positions = 2 * n * (cond_len + ttok + 1 + steps)
            kib_per_pos = t3_peak * 1024 * 1024 / positions if positions else 0.0
            print(f"  {n:>3} {chars:>6} {ttok:>5} {steps:>6} {positions:>9} "
                  f"{t3_peak:>7.2f} {s3_peak:>7.2f} {max(t3_peak, s3_peak):>8.2f} "
                  f"{free_before - free_after:>8.2f} {kib_per_pos:>8.2f} "
                  f"{t3_s:>7.2f} {s3_s:>6.2f} {audio:>8.1f}", flush=True)
            rows_out.append({"n": n, "chars": chars, "text_tokens": ttok, "steps": steps,
                             "positions": positions, "t3_peak_gb": round(t3_peak, 4),
                             "s3_peak_gb": round(s3_peak, 4),
                             "card_cost_gb": round(free_before - free_after, 4),
                             "t3_s": round(t3_s, 3), "s3_s": round(s3_s, 3),
                             "audio_s": round(audio, 2), "voc_per_pass": per_pass,
                             "speech_tokens_max": stok,
                             "text_chars_actual": len(texts[0])})
            flush_json()
            del tok_rows, wavs
            torch.cuda.empty_cache()

    flush_json()
    print(f"\n  {len(rows_out)} cells -> {args.out}", flush=True)


def cmd_creep(args):
    """Check whether VRAM use grows across many renders or returns after each pass.

    This differs from the other measurements in this file, which examine the
    peak of ONE pass. This one is about the floor between passes, over a long run, and the
    mechanism is real: `empty_cache()` returns only segments that are ENTIRELY free, so a single
    long-lived tensor pins its whole segment. Batch size and sequence length change on every
    render of a real book, which is the pattern most likely to strand segments.

    The workload is deliberately RAGGED — batch sizes and chunk lengths cycle on different
    periods, so no two consecutive passes ask for the same shape. A uniform workload would let
    the allocator reuse every block and would prove nothing.

    Three numbers per round, and it is the third that answers the question:
      * allocated  — live tensors. Should return to the replica baseline every round.
      * reserved   — the allocator's pool. May exceed allocated; the question is whether it GROWS.
      * card free  — what `mem_get_info` says after `empty_cache()`; a monotone decline indicates
        memory is not returning to the baseline.
    """
    print(f"== VRAM across {args.rounds} rounds of ragged batches — does it come back? ==")
    free0, total = vram()
    model = load_model()
    render(model, _text_of_length(80), seed=1)
    torch.cuda.empty_cache()
    base_alloc = gb(torch.cuda.memory_allocated())
    base_free, _ = vram()
    print(f"  card {free0:.2f} GB free before load; replica resident at "
          f"{base_alloc:.2f} GB allocated, {base_free:.2f} GB card free\n")

    # Coprime-ish cycles so the (size, length) pair does not repeat for many rounds.
    SIZES = [3, 8, 5, 16, 4, 11, 6, 2]
    LENGTHS = [400, 90, 250, 60, 380, 150, 310]
    print(f"  {'round':>5} {'n':>3} {'chars':>6} {'alloc':>8} {'reserved':>9} "
          f"{'free after':>11} {'vs round 1':>11}")
    first_free = None
    for k in range(args.rounds):
        n = SIZES[k % len(SIZES)]
        chars = LENGTHS[k % len(LENGTHS)]
        texts = [_text_of_length(chars, salt=7 * (k + i)) for i in range(n)]
        out = sat.render_batch(model, texts, device=DEVICE)
        assert len(out) == n
        del out
        # The honest reading: what is left AFTER the caller has finished and the cache is dropped.
        torch.cuda.empty_cache()
        alloc = gb(torch.cuda.memory_allocated())
        resv = gb(torch.cuda.memory_reserved())
        free_now, _ = vram()
        first_free = free_now if first_free is None else first_free
        print(f"  {k+1:>5} {n:>3} {chars:>6} {alloc:>8.3f} {resv:>9.3f} "
              f"{free_now:>10.2f}G {free_now - first_free:>+10.2f}G", flush=True)

    end_free, _ = vram()
    leaked = base_free - end_free
    print(f"\n  replica baseline {base_free:.2f} GB free -> {end_free:.2f} GB after "
          f"{args.rounds} rounds")
    # ⚠️ ASCII ONLY on this path. This prints to a Windows console whose codec is cp1252, and a
    # stray emoji raises UnicodeEncodeError AFTER the measurement has been made — which is
    # exactly how the first run of this command died, with all 24 rounds already on screen and
    # an exit code of 1. `cmd_vrambatch` carries the same warning; I wrote it and then did it.
    if leaked > args.tolerance:
        print(f"  *** {leaked:.2f} GB DID NOT COME BACK (tolerance {args.tolerance:.2f} GB) -- "
              f"that is a ratchet, not a transient peak")
    else:
        print(f"  OK: {leaked:+.2f} GB net, inside the {args.tolerance:.2f} GB tolerance -- "
              f"VRAM returns to the replica baseline after every batch")


def cmd_shipped(args):
    """Drive `render_batch_iter` — the function the satellite actually calls — end to end.

    This measures the shipped path: `batch_cap`
    choosing the size from free VRAM, `_one_pass` decoding behind the watchdog, `_vocode_rows`
    splitting the vocode, and the incremental yield. Exercise the real path because a VRAM model
    can pass unit tests and still behave differently with a device driver.

    Serial control in the SAME process, bracketed before and after, because the 4090 loses clock
    under sustained load and a single control measured first would flatter the batched arm.
    """
    print(f"== the SHIPPED path: render_batch_iter, {args.n} chunks of ~{args.chars} chars ==")
    free0, total = vram()
    print(f"  card: {free0:.2f} of {total:.2f} GB free")
    model = load_model()
    render(model, _text_of_length(80), seed=1)                # warm
    torch.cuda.empty_cache()
    free_loaded, _ = vram()
    texts = [_text_of_length(args.chars, salt=7 * i) for i in range(args.n)]
    longest = max(len(t) for t in texts)
    print(f"  replica resident, {free_loaded:.2f} GB free")
    print(f"  batch_cap says {sat.batch_cap(DEVICE, args.n, texts)} chunks per pass "
          f"(longest chunk {longest} chars, model predicts "
          f"{sat.pass_cost_gb(sat.batch_cap(DEVICE, args.n, texts), longest):.2f} GB)\n")

    def serial_arm(label):
        torch.cuda.empty_cache()
        torch.manual_seed(500)
        torch.cuda.synchronize()
        t0 = time.time()
        audio = 0.0
        for t in texts:
            wav = model.generate(t, exaggeration=0.5, cfg_weight=0.5, temperature=0.8)
            audio += wav.shape[-1] / model.sr
        torch.cuda.synchronize()
        dt = time.time() - t0
        print(f"  {label:<9}: {audio:7.2f}s audio in {dt:7.2f}s = {audio/dt:6.3f}x realtime")
        return audio, dt

    s1_audio, s1_dt = serial_arm("SERIAL")

    torch.cuda.empty_cache()
    torch.manual_seed(500)
    torch.cuda.synchronize()
    t0 = time.time()
    got, audio, worst_free, first_at = {}, 0.0, free_loaded, None
    for idx, wav in sat.render_batch_iter(model, texts, device=DEVICE):
        got[idx] = wav
        audio += len(wav) / model.sr
        if first_at is None:
            first_at = time.time() - t0
        worst_free = min(worst_free, free_gb_now())
    torch.cuda.synchronize()
    b_dt = time.time() - t0
    print(f"  BATCHED  : {audio:7.2f}s audio in {b_dt:7.2f}s = {audio/b_dt:6.3f}x realtime")
    # ⚠️ `worst_free` is sampled at the YIELDS, not during a pass — when the whole submission
    # fits in one pass it is read after the memory has already gone back, and reads as if
    # nothing happened. It is a floor on what the caller ever saw, not a peak. The peak that
    # matters is the allocator's, and the watchdog is what guards it.
    print(f"             first chunk back at {first_at:.2f}s; free VRAM at the yields never "
          f"below {worst_free:.2f} GB, allocator peak "
          f"{gb(torch.cuda.max_memory_allocated()):.2f} GB")

    s2_audio, s2_dt = serial_arm("SERIAL-2")
    drift = (s2_audio / s2_dt) / (s1_audio / s1_dt)
    # ASCII — see the note in cmd_batched. This is the branch that fires exactly when the run is
    # untrustworthy, and it used to crash the process before it could print the SPEEDUP line.
    note = "stable" if 0.95 <= drift <= 1.05 else "*** SUSPECT - the controls disagree"
    print(f"             drift between the two controls: {drift:.2f}x ({note})")

    # Correctness is not optional just because this run is about speed.
    assert len(got) == len(texts), f"got {len(got)} chunks back for {len(texts)} sent"
    assert all(i in got for i in range(len(texts))), "an index went missing"
    best_serial = max(s1_audio / s1_dt, s2_audio / s2_dt)
    print(f"\n  SPEEDUP  : {(audio/b_dt)/best_serial:.2f}x against the BEST serial arm "
          f"({args.n} chunks, {longest} chars at the longest)")


def cmd_full(args):
    """Both stages batched, against the serial path, at several batch sizes.

    §3 of the results doc batched T3 only and left S3Gen one chunk at a time, where it grew
    from 7% of a serial render to 36% of a batched 8-chunk one. This is the same test with
    that hole closed.

    Guard batches to leave VRAM available for other desktop workloads. A batch's cost is a
    render-time cost that scales with batch size, so `act_headroom_gb`'s load-time
    fit check (tts_utils.py:1570) does not cover it -- nothing does. Refuse any size that
    would leave less than --reserve free, and treat an OOM as the measured ceiling rather
    than as a crash.
    """
    print("== T3 AND S3Gen batched, vs one chunk at a time ==")
    free0, total = vram()
    print(f"  card: {free0:.2f} of {total:.2f} GB free before we start, "
          f"reserving {args.reserve:.1f} GB for whatever else is running")
    model = load_model()
    # Two warm renders, not one: the serial arm's shapes are the same at every batch size,
    # so warming it once globally is enough -- but it does have to actually happen.
    render(model, TEXT, seed=1)                               # build patched_model
    render(model, TEXT, seed=1)                               # warm the serial shapes

    for n in args.sizes:
        free_now, _ = vram()
        if free_now < args.reserve:
            print(f"\n  n={n}: SKIPPED -- only {free_now:.2f} GB free, under the "
                  f"{args.reserve:.1f} GB reserve. Something else wants the card.")
            break
        texts = [CHUNKS[i % len(CHUNKS)] for i in range(n)]
        rows = [_text_tokens(model, t) for t in texts]

        # Warm THIS batch size before timing it. ROCm/MIOpen compiles and tunes kernels
        # per tensor shape on first use, so every new batch size pays a one-time compile --
        # inside the timed region if you let it. Unwarmed, an R9700 reported 36 s in S3Gen
        # at n=8 where the same code took 2.08 s on CUDA, and 137 s at n=16: that is a
        # compiler, not a vocoder. CUDA hides this well enough that the harness got away
        # without it until the first ROCm run. Cheap on CUDA, essential here.
        if args.warm:
            try:
                torch.manual_seed(1)
                _vocode_batched(model, batched_t3(model.t3, model.conds.t3, rows,
                                                  temperature=0.8, cfg_weight=0.5)[0])
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                print(f"\n  n={n}: OOM during warm-up -- measured ceiling is below this size.")
                break
            torch.cuda.empty_cache()

        torch.cuda.reset_peak_memory_stats()
        torch.manual_seed(500)
        torch.cuda.synchronize()
        t0 = time.time()
        s_tok = 0
        for t in texts:
            with Stages(model) as st:
                model.generate(t, exaggeration=0.5, cfg_weight=0.5, temperature=0.8)
            s_tok += st.t["tokens"]
        torch.cuda.synchronize()
        s_dt = time.time() - t0
        s_peak = gb(torch.cuda.max_memory_allocated())

        torch.cuda.reset_peak_memory_stats()
        torch.manual_seed(500)
        torch.cuda.synchronize()
        t0 = time.time()
        try:
            tok_rows, steps = batched_t3(model.t3, model.conds.t3, rows,
                                         temperature=0.8, cfg_weight=0.5)
            torch.cuda.synchronize()
            t3_dt = time.time() - t0
            wavs = _vocode_batched(model, tok_rows)
            torch.cuda.synchronize()
        except torch.cuda.OutOfMemoryError:
            # The ceiling is a RESULT, not a failure -- it is the number the render-time
            # guard has to be built against. Give the card back before saying so.
            free_at_oom, _ = vram()
            torch.cuda.empty_cache()
            print(f"\n  n={n:<3} OOM -- this is the measured ceiling with "
                  f"{free0:.2f} GB free at the start ({free_at_oom:.2f} GB at the OOM). "
                  f"Peak before it died: {gb(torch.cuda.max_memory_allocated()):.2f} GB.")
            break
        b_dt = time.time() - t0
        b_peak = gb(torch.cuda.max_memory_allocated())
        b_tok = sum(r.numel() for r in tok_rows)
        audio = sum(len(w) for w in wavs) / model.sr

        print(f"\n  n={n:<3} serial {s_tok/s_dt:6.1f} tok/s in {s_dt:6.2f}s "
              f"(peak {s_peak:.2f} GB)")
        print(f"       batched {b_tok/b_dt:6.1f} tok/s in {b_dt:6.2f}s "
              f"(peak {b_peak:.2f} GB)  -> {(b_tok/b_dt)/(s_tok/s_dt):5.2f}x")
        print(f"       t3 {t3_dt:5.2f}s ({100*t3_dt/b_dt:4.1f}%)  "
              f"s3gen+wm {b_dt-t3_dt:5.2f}s ({100*(b_dt-t3_dt)/b_dt:4.1f}%)  "
              f"{audio:.1f}s audio  {steps} steps for "
              f"{max(r.numel() for r in tok_rows)} max tokens")
        print(f"       VRAM cost of batching this many: "
              f"+{b_peak - s_peak:.2f} GB over one chunk at a time")
        del tok_rows, wavs
        torch.cuda.empty_cache()


# ── verify ────────────────────────────────────────────────────────────────────

def cmd_verify(args):
    """A batch of ONE must reproduce stock T3.inference token for token.

    Same seed, same text, no padding involved at n=1 -- so any divergence is a bug in
    the batched reimplementation, not sampling noise. This is the check that says the
    speedup is real work rather than a fast wrong answer; the timing runs mean nothing
    without it.
    """
    print("== batched-of-one vs stock T3.inference, identical seed ==")
    model = load_model()
    render(model, TEXT, seed=1)                               # build patched_model
    t3 = model.t3

    ok = 0
    for idx, text in enumerate(CHUNKS):
        row = _text_tokens(model, text)

        torch.manual_seed(900 + idx)
        with torch.inference_mode():
            tt = torch.cat([row.unsqueeze(0), row.unsqueeze(0)], dim=0)
            stock = t3.inference(t3_cond=model.conds.t3, text_tokens=tt,
                                 max_new_tokens=1000, temperature=0.8, cfg_weight=0.5,
                                 repetition_penalty=1.2, min_p=0.05, top_p=1.0)[0]
        from chatterbox.models.s3tokenizer import drop_invalid_tokens
        stock = drop_invalid_tokens(stock)
        stock = stock[stock < 6561]

        torch.manual_seed(900 + idx)
        # Compare the shipped decode with the stock path so this fidelity check covers the
        # implementation used by the application.
        mine, _ = sat.batched_t3(t3, model.conds.t3, [row], temperature=0.8, cfg_weight=0.5)
        mine = mine[0]
        mine = mine[mine < 6561]

        same = stock.numel() == mine.numel() and bool((stock == mine).all())
        if same:
            ok += 1
            print(f"  chunk {idx}: IDENTICAL, {stock.numel()} tokens")
        else:
            k = min(stock.numel(), mine.numel())
            div = next((j for j in range(k) if stock[j] != mine[j]), k)
            print(f"  chunk {idx}: DIVERGED at token {div}/{k} "
                  f"(stock {stock.numel()} tokens, batched {mine.numel()})")

    print(f"\n  {ok}/{len(CHUNKS)} chunks reproduce the stock path exactly")
    if ok != len(CHUNKS):
        print("  -> the batched decode is NOT a faithful generalization. Numbers are void.")

    # ── the vocoder half ──────────────────────────────────────────────────────
    # Batching S3Gen is a recommendation too, so it gets the same standard. Same token
    # rows down both paths; the only difference is the batch dimension and the padding,
    # so any waveform divergence is the padding leaking across sequences.
    print("\n== batched S3Gen vs one-at-a-time, identical speech tokens ==")
    rows = []
    for idx, text in enumerate(CHUNKS):
        torch.manual_seed(700 + idx)
        r = sat.batched_t3(t3, model.conds.t3, [_text_tokens(model, text)],
                           temperature=0.8, cfg_weight=0.5)[0][0]
        rows.append(r)
    print(f"  token counts {[r.numel() for r in rows]} "
          f"(padded to {max(r.numel() for r in rows)} in the batch)")

    # The shipped vocoder pair too, for the same reason as the decode above.
    torch.manual_seed(4242)
    one_at_a_time = [sat.vocode_one(model, r) for r in rows]
    torch.manual_seed(4242)
    together = sat.vocode_batched(model, rows)

    worst = 0.0
    for i, (a, b) in enumerate(zip(one_at_a_time, together)):
        if len(a) != len(b):
            print(f"  chunk {i}: LENGTH MISMATCH {len(a)} vs {len(b)} samples")
            worst = float("inf")
            continue
        # S3Gen's flow matching draws noise, so these are not bit-identical even at
        # batch 1 -- correlation is the honest measure, not equality.
        c = float(np.corrcoef(a, b)[0, 1])
        rms_a, rms_b = float(np.sqrt((a ** 2).mean())), float(np.sqrt((b ** 2).mean()))
        worst = max(worst, abs(rms_a - rms_b) / rms_a)
        print(f"  chunk {i}: {len(a)} samples both, corr {c:+.4f}, "
              f"rms {rms_a:.4f} vs {rms_b:.4f} ({100*(rms_b-rms_a)/rms_a:+.1f}%)")
    print(f"\n  worst RMS drift {100*worst:.1f}% -- lengths must match exactly; a padded "
          f"sequence bleeding into its neighbor would show up here first")

    # S3Gen's flow-matching decoder draws noise, so serial renders can differ across seeds.
    # This control distinguishes expected sampling variation from padding-related divergence.
    print("\n  control -- the SAME chunk vocoded twice serially, different seeds:")
    for i in (0, 1):
        torch.manual_seed(11)
        a = _vocode(model, rows[i])
        torch.manual_seed(99)
        b = _vocode(model, rows[i])
        c = float(np.corrcoef(a, b)[0, 1])
        ra, rb = float(np.sqrt((a ** 2).mean())), float(np.sqrt((b ** 2).mean()))
        print(f"    chunk {i}: corr {c:+.4f}, rms {ra:.4f} vs {rb:.4f} "
              f"({100*(rb-ra)/ra:+.1f}%)  <- serial vs ITSELF")
    print("\n  If this control's correlation is as low as the batched comparison's, the")
    print("  batched vocoder is fine and correlation is simply the wrong instrument here.")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("baseline"); b.add_argument("--runs", type=int, default=3)
    b.set_defaults(fn=cmd_baseline)

    v = sub.add_parser("vram"); v.add_argument("--replicas", type=int, default=2)
    v.set_defaults(fn=cmd_vram)

    t = sub.add_parser("two")
    t.add_argument("--workers", type=int, default=2)
    t.add_argument("--each", type=int, default=4)
    t.add_argument("--control", action="store_true")
    t.set_defaults(fn=cmd_two)

    m = sub.add_parser("micro")
    m.add_argument("--batches", type=int, nargs="+", default=[2, 4, 8, 16, 32])
    m.add_argument("--prefix", type=int, default=200)
    m.add_argument("--steps", type=int, default=100)
    m.set_defaults(fn=cmd_micro)

    d = sub.add_parser("dtype"); d.set_defaults(fn=cmd_dtype)

    vb = sub.add_parser("vrambatch")
    vb.add_argument("--sizes", type=int, nargs="+", default=[1, 2, 4, 8, 10, 12, 16])
    vb.add_argument("--reserve", type=float, default=6.0,
                    help="GB of card free VRAM to leave alone (default 6)")
    vb.add_argument("--abort-below", type=float, default=2.5,
                    help="GB of free VRAM at which the watchdog stops the pass. The driver "
                         "pages to host RAM instead of raising, so this is the real guard.")
    vb.add_argument("--long", action="store_true",
                    help="use the 250-400 char CHUNKS instead of the short ones -- the shape "
                         "the n=16 run that exhausted the card actually had")
    vb.set_defaults(fn=cmd_vrambatch)

    vg = sub.add_parser("vramgrid")
    vg.add_argument("--sizes", type=int, nargs="+", default=[1, 2, 4, 8, 12, 16, 24, 32])
    vg.add_argument("--lengths", type=int, nargs="+", default=[60, 180, 300, 400],
                    help="target chunk length in CHARACTERS. Vocalis splits at 400 "
                         "(tts_utils.CHUNK_SIZE), so that is the top of the real domain.")
    vg.add_argument("--abort-below", type=float, default=3.0,
                    help="GB of free VRAM at which the watchdog stops the pass")
    vg.add_argument("--voc-tokens", type=int, default=2000,
                    help="speech-token budget for ONE batched S3Gen pass (rows x padded "
                         "length). The vocoder has no watchdog inside it, so this is the only "
                         "thing standing between a big batch and the PCIe paging regime.")
    vg.add_argument("--drop-every", type=int, default=0,
                    help="call torch.cuda.empty_cache() every N decode steps. 0 = never, which "
                         "is what ships today. See _watch_and_drop for why this is the only "
                         "lever available on Windows.")
    vg.add_argument("--out", default="temp/vramgrid.json")
    vg.set_defaults(fn=cmd_vramgrid)

    cr = sub.add_parser("creep")
    cr.add_argument("--rounds", type=int, default=24)
    cr.add_argument("--tolerance", type=float, default=0.30,
                    help="GB of drift to accept as noise rather than a ratchet")
    cr.set_defaults(fn=cmd_creep)

    sh = sub.add_parser("shipped")
    sh.add_argument("-n", type=int, default=16)
    sh.add_argument("--chars", type=int, default=400)
    sh.set_defaults(fn=cmd_shipped)

    vf = sub.add_parser("verify"); vf.set_defaults(fn=cmd_verify)

    fu = sub.add_parser("full")
    fu.add_argument("--sizes", type=int, nargs="+", default=[1, 2, 4, 8])
    # Leave enough VRAM for other desktop workloads.
    fu.add_argument("--reserve", type=float, default=8.0,
                    help="GB of card free VRAM to leave alone (default 8)")
    fu.add_argument("--no-warm", dest="warm", action="store_false",
                    help="skip the per-batch-size warm-up (invalidates ROCm numbers)")
    fu.set_defaults(fn=cmd_full, warm=True)

    e = sub.add_parser("batched")
    e.add_argument("-n", type=int, default=4)
    e.add_argument("--save", action="store_true")
    e.set_defaults(fn=cmd_batched)

    args = p.parse_args()
    if not torch.cuda.is_available():
        sys.exit("no CUDA")
    print(f"torch {torch.__version__}  {torch.cuda.get_device_name(0)}\n")
    args.fn(args)


if __name__ == "__main__":
    main()
