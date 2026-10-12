"""Build explicit ACE-Step `/release_task` payloads.

The request model and generation dataclasses use different defaults, so every payload field that
affects rendering is set explicitly. Model-specific values below mirror the backend's UI and
generation configuration:

    field            request model      GenerationParams / GenerationConfig
    shift            3.0                1.0
    thinking         False              True
    audio_format     mp3                flac
    allow_lm_batch   True               False
    lm_cfg_scale     2.5                2.0   (and the Gradio slider shows 2.0)
    batch_size       None               2

The DCW settings and step counts vary by model, and the seed is supplied per job so concurrent
cards can render distinct outputs. `batch_size` stays at one because parallelism is provided by
card-level dispatch.
"""
from __future__ import annotations

from typing import Any

#: Which models get DCW, mirroring Gradio's per-model checkbox rather than the dataclass default.
#: Anything not named here is treated as a base model (DCW on), which is the dataclass's own
#: behavior — the exception list is what is measured, not the rule.
_DCW_OFF = ("acestep-v15-xl-sft",)

#: Steps per model, from `model_config.py:114-145`. A model not named here gets the base default.
#: October 11, 2026: `acestep-v15-xl-base` added at 50 because its publisher's model card states it in
#: its architecture table ("Inference steps | 50 (with CFG)"). Its shift and DCW stay at the base defaults
#: below: the card gives no value for either.
_STEPS = {"acestep-v15-turbo": 8, "acestep-v15-xl-sft": 50, "acestep-v15-xl-base": 50}
_STEPS_BASE = 32

#: Model-specific timestep shifts. Unknown models use the base value; keep this list aligned with
#: the upstream sampler behavior rather than relying on request-model defaults.
_SHIFT = {"acestep-v15-turbo": 3.0, "acestep-v15-xl-turbo": 3.0}
_SHIFT_BASE = 1.0


# ── which tasks each model may be asked to run (October 11, 2026) ───────────────────────────────
# 🔴 THE ENGINE'S OWN ANSWER IS WRONG FOR xl-sft. The engine's `/v1/model_inventory` lists a model's
# tasks from one flag, `is_turbo` in config.json: false means all seven task types. `acestep-v15-xl-sft`
# and `acestep-v15-xl-base` ship a BYTE-IDENTICAL config.json (same Git blob bfab8d22…, `is_turbo` false,
# `model_version` "base" in both), so the engine offers Extract, Lego and Complete to the fine-tuned
# model too. The publisher says otherwise, in two places, and the engine's own Gradio UI agrees by name:
#   - the xl-base model card (ACE-Step/acestep-v15-xl-base, README.md, "Model Zoo" table): xl-base
#     "All (extract, lego, complete)"; acestep-v15-xl-sft, acestep-v15-xl-turbo "Standard"; the same card
#     says of xl-base "It is the foundation model supporting all tasks: text-to-music, cover, repaint,
#     extract, lego, and complete."
#   - the engine repository's README (ACE-Step-1.5 at the pinned commit 6d467e4, "DiT Models" and "XL (4B)
#     DiT Models" tables): Extract, Lego and Complete are ticked for acestep-v15-base and acestep-v15-xl-base
#     only, crossed out for sft, turbo, xl-sft and xl-turbo; its VRAM table says "XL sft (or xl-base for
#     extract/lego/complete)". Its Gradio UI offers the seven-task list only to a model whose NAME has a
#     "base" token and no "sft"/"turbo" token (`is_pure_base_model`).
# So the music page narrows what the engine reports to what the publisher lists, by model NAME (the files
# cannot tell the two models apart). A model not in this table keeps the engine's own answer.
# "Standard" is the engine's four-task set (`TASK_TYPES_TURBO`): text2music, repaint, cover and cover-nofsq
# (the same cover task without the FSQ round trip).
_STANDARD_TASKS = ("text2music", "repaint", "cover", "cover-nofsq")
_ALL_TASKS = (*_STANDARD_TASKS, "extract", "lego", "complete")

#: model name -> the task types its publisher lists for it. Only xl-base lists Extract, Lego and Complete.
#: Setup downloads turbo, xl-sft and xl-base; xl-turbo is named on the same card and is here so a copy
#: dropped into the folder by hand is judged by the publisher's table, not by the engine's flag. The 2B sft
#: and base models are not downloaded and have no row (they keep the engine's answer).
PUBLISHED_TASKS = {
    "acestep-v15-turbo": _STANDARD_TASKS,
    "acestep-v15-xl-turbo": _STANDARD_TASKS,
    "acestep-v15-xl-sft": _STANDARD_TASKS,
    "acestep-v15-xl-base": _ALL_TASKS,
}


def narrow_tasks(model: str, reported) -> list:
    """What `model` may run: the engine's `reported` list cut down to the publisher's list for it.

    A model not in `PUBLISHED_TASKS` keeps the engine's answer unchanged. The result never holds a task
    the engine did not report (an engine that says a model cannot do something is believed), and keeps
    the engine's order.
    """
    published = PUBLISHED_TASKS.get(str(model or ""))
    got = list(reported or [])
    if published is None:
        return got
    return [t for t in got if t in published]


def published_models_for(task: str) -> list:
    """The models whose publisher lists `task`, sorted: what a refusal or a tooltip should tell the user to load."""
    return sorted(m for m, tasks in PUBLISHED_TASKS.items() if task in tasks)


def models_by_task() -> dict:
    """task -> [model, …] for every task type: the page's way of naming the model a disabled mode needs."""
    return {t: published_models_for(t) for t in _ALL_TASKS}


def steps_for(model: str) -> int:
    return _STEPS.get(str(model or ""), _STEPS_BASE)


def shift_for(model: str) -> float:
    return _SHIFT.get(str(model or ""), _SHIFT_BASE)


def dcw_for(model: str, thinking: bool) -> dict:
    """Gradio's per-model DCW settings, including Think-mode scaler values."""
    on = str(model or "") not in _DCW_OFF
    if not on:
        # Sent explicitly as False rather than omitted: omitted means True (see the header).
        return {"dcw_enabled": False, "dcw_mode": "double", "dcw_scaler": 0.05,
                "dcw_high_scaler": 0.02, "dcw_wavelet": "haar"}
    lo, hi = (0.02, 0.06) if thinking else (0.05, 0.02)
    return {"dcw_enabled": True, "dcw_mode": "double", "dcw_scaler": lo,
            "dcw_high_scaler": hi, "dcw_wavelet": "haar"}


# Mode selects `task_type`; other fields are sent explicitly because the
# backend ignores fields that do not apply to that task. Offer only task types
# reported by backend inventory. Retake and Edit remain text2music modes; Edit
# additionally requires source audio when morphing is enabled.
MODE_TASK = {
    "simple": "text2music",     # the words come from the LM; the render is an ordinary one
    "custom": "text2music",
    "retake": "text2music",     # + retake_variance > 0
    "edit": "text2music",       # + flow_edit_morph, and it needs src_audio
    "remix": "cover",
    "remix-nofsq": "cover-nofsq",
    "repaint": "repaint",
    "extract": "extract",
    "lego": "lego",
    "complete": "complete",
}

#: Modes whose backend operation requires source audio. Edit requires it when
#: flow morphing is enabled; Retake changes sampling noise and does not.
MODES_NEEDING_SOURCE = ("remix", "remix-nofsq", "repaint", "extract", "lego", "complete", "edit")

# Track modes use structured fields rather than an assembled instruction string.
# Extract/Lego take one `track_name`; Complete takes a `track_classes` list.
# Missing selections use the backend's mode-specific default.

#: Supported track identifiers, in backend picker order.
TRACK_NAMES = ("woodwinds", "brass", "fx", "synth", "strings", "percussion",
               "keyboard", "guitar", "bass", "drums", "backing_vocals", "vocals")

#: Which modes read which field. Anything not named here sends neither.
MODES_ONE_TRACK = ("extract", "lego")
MODES_MANY_TRACKS = ("complete",)


def _num(v, default: float) -> float:
    """Parse a form number, using the default for blank or invalid values while preserving zero."""
    if v in (None, ""):
        return float(default)
    try:
        return float(v)
    except (TypeError, ValueError):
        # A hand-edited template or a stale draft must not 500 a press that took a paragraph of
        # lyrics to set up. Same reasoning as `_seed_for`'s clamp: a knob is not an instruction.
        return float(default)


def _opt_num(v):
    """Parse an optional number; blank or invalid values remain unset."""
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _is(t: dict, mode: str) -> bool:
    """Return whether the template mode matches, case-insensitively."""
    return str(t.get("mode") or "").lower() == mode


def _valid_tracks(raw) -> list:
    """Return unique, supported track names in the order supplied."""
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []
    seen, out = set(), []
    for t in raw:
        name = str(t or "").strip().lower()
        if name in TRACK_NAMES and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _track_name(t: dict):
    """Return the selected track for Extract/Lego, or None for the upstream default."""
    if str(t.get("mode") or "").lower() not in MODES_ONE_TRACK:
        return None
    got = _valid_tracks(t.get("tracks"))
    return got[0] if got else None


def _track_classes(t: dict):
    """Return the selected track list for Complete, or None for the upstream default."""
    if str(t.get("mode") or "").lower() not in MODES_MANY_TRACKS:
        return None
    return _valid_tracks(t.get("tracks")) or None


def task_type_for(mode: str) -> str:
    """Return the wire task type for a mode, defaulting to text-to-music."""
    return MODE_TASK.get(str(mode or "").lower(), "text2music")


def build_payload(*, template: dict, settings: dict, model: str, seed: int,
                  reference_path: str = "", source_path: str = "") -> dict[str, Any]:
    """Build a complete `/release_task` payload with explicit generation fields.

    The template provides song identity, settings provide render controls, the model
    selects model-specific defaults, and `seed` identifies this job. Audio paths are
    already staged by the caller; this function performs no I/O.
    """
    t, s = dict(template or {}), dict(settings or {})
    thinking = bool(s.get("thinking", True))
    duration = t.get("duration")

    payload: dict[str, Any] = {
        # ── the song ─────────────────────────────────────────────────────────────────────
        "prompt": t.get("caption") or "",
        "global_caption": t.get("global_caption") or "",
        "lyrics": "" if t.get("instrumental") else (t.get("lyrics") or ""),
        "bpm": _opt_num(t.get("bpm")),
        "key_scale": t.get("key_scale") or "",
        "time_signature": t.get("time_signature") or "",
        "vocal_language": t.get("vocal_language") or "en",
        # Non-positive duration selects the backend's automatic duration behavior.
        "audio_duration": _num(duration, -1.0) or -1.0,
        "task_type": task_type_for(t.get("mode")),
        # ── the source-audio modes (m3) ──────────────────────────────────────────────────
        # The request builder accepts `src_audio_path` and maps it to `src_audio`.
        "src_audio_path": str(source_path or ""),
        # `repainting_end` uses `None` to mean through the end of the song.
        # Numeric parsing preserves zero while treating blank values as defaults.
        "repainting_start": _num(t.get("repaint_start"), 0.0),
        "repainting_end": _opt_num(t.get("repaint_end")),
        # Cover strength controls retained source content; the following fields
        # control how the replaced section is joined.
        "audio_cover_strength": _num(t.get("cover_strength"), 1.0),
        # Parse numeric settings through `_num` so null or invalid values use
        # defaults without changing valid zero values.
        "cover_noise_strength": _num(s.get("cover_noise_strength"), 0.0),
        "repaint_mode": s.get("repaint_mode") or "balanced",
        "repaint_strength": _num(s.get("repaint_strength"), 0.5),
        "repaint_latent_crossfade_frames": int(_num(s.get("repaint_latent_crossfade_frames"), 10)),
        "repaint_wav_crossfade_sec": _num(s.get("repaint_wav_crossfade_sec"), 0.0),
        "chunk_mask_mode": s.get("chunk_mask_mode") or "auto",
        # ── the track modes (m4) ─────────────────────────────────────────────────────────
        # Keep the singular/plural field types expected by upstream. `None` selects
        # the mode default when no track is chosen.
        "track_name": _track_name(t),
        "track_classes": _track_classes(t),
        # ── retake and edit (m5) ─────────────────────────────────────────────────────────
        # Zero variance leaves the render unchanged; other modes always send zero.
        "retake_variance": _num(t.get("retake_variance"), 0.2) if _is(t, "retake") else 0.0,
        # `retake_seed` is the source render's seed, distinct from this job's seed.
        "retake_seed": t.get("retake_seed") if _is(t, "retake") else None,
        "flow_edit_morph": _is(t, "edit"),
        # The source description defines the source side of the edit-morph delta.
        "flow_edit_source_caption": str(t.get("edit_from_caption") or "") if _is(t, "edit") else "",
        "flow_edit_source_lyrics": str(t.get("edit_from_lyrics") or "") if _is(t, "edit") else "",
        "flow_edit_n_min": _num(s.get("flow_edit_n_min"), 0.0),
        "flow_edit_n_max": _num(s.get("flow_edit_n_max"), 1.0),
        "flow_edit_n_avg": int(_num(s.get("flow_edit_n_avg"), 1) or 1),
        # The request field is `reference_audio_path`; blank means no reference.
        "reference_audio_path": str(reference_path or ""),
        # ── this job's identity ──────────────────────────────────────────────────────────
        "seed": int(seed),
        "use_random_seed": False,        # we choose it, so the two cards cannot collide
        "batch_size": 1,                 # parallelism is CARDS; see the header
        "model": model,
        # ── model-driven, from the CARD not the form ─────────────────────────────────────
        "inference_steps": int(_num(s.get("inference_steps"), 0) or steps_for(model)),
        # ── the six that disagree between request model and pipeline (§5.2) ──────────────
        # A blank shift uses the target model's recommended value.
        "shift": _num(s.get("shift"), shift_for(model)),
        "thinking": thinking,
        "audio_format": "flac",          # lossless: Voice Swap and Demucs consume these later
        "allow_lm_batch": bool(s.get("allow_lm_batch", False)),
        "lm_cfg_scale": _num(s.get("lm_cfg_scale"), 2.0),
        # ── the rest of the routine surface, all explicit ────────────────────────────────
        "guidance_scale": _num(s.get("guidance_scale"), 7.0),
        "use_adg": bool(s.get("use_adg", False)),
        "cfg_interval_start": _num(s.get("cfg_interval_start"), 0.0),
        "cfg_interval_end": _num(s.get("cfg_interval_end"), 1.0),
        "infer_method": s.get("infer_method") or "ode",
        "use_tiled_decode": bool(s.get("use_tiled_decode", True)),
        "lm_temperature": _num(s.get("lm_temperature"), 0.85),
        "lm_top_p": _num(s.get("lm_top_p"), 0.9),
        "lm_negative_prompt": s.get("lm_negative_prompt") or "NO USER INPUT",
        "use_cot_caption": bool(s.get("use_cot_caption", True)),
        "use_cot_language": bool(s.get("use_cot_language", True)),
        # ── m7: the rest of the LM surface, and only the parts that EXIST ────────────────
        # Omit UI-only controls without request-model fields; they cannot affect
        # backend generation.
        "lm_top_k": (lambda v: None if v is None else int(v))(_opt_num(s.get("lm_top_k"))),
        "constrained_decoding": bool(s.get("constrained_decoding", True)),
        "lm_batch_chunk_size": int(_num(s.get("lm_batch_chunk_size"), 8) or 8),
        # `None` leaves the backend's timestep configuration unchanged.
        "timesteps": str(s["timesteps"]) if s.get("timesteps") not in (None, "") else None,
        # ── unreachable without the M0 overlay; sent because it is applied either way ─────
        "sampler_mode": s.get("sampler_mode") or "euler",
        "velocity_norm_threshold": _num(s.get("velocity_norm_threshold"), 0.0),
        "velocity_ema_factor": _num(s.get("velocity_ema_factor"), 0.0),
        "enable_normalization": bool(s.get("enable_normalization", True)),
        "normalization_db": _num(s.get("normalization_db"), -1.0),
        "fade_in_duration": _num(s.get("fade_in_duration"), 0.0),
        "fade_out_duration": _num(s.get("fade_out_duration"), 0.0),
        "latent_shift": _num(s.get("latent_shift"), 0.0),
        "latent_rescale": _num(s.get("latent_rescale"), 1.0),
    }
    # Key presence preserves an explicit false override; otherwise use the
    # target model's DCW defaults.
    dcw = dcw_for(model, thinking)
    if "dcw_enabled" in s:
        dcw["dcw_enabled"] = bool(s["dcw_enabled"])
    for k in ("dcw_mode", "dcw_scaler", "dcw_high_scaler", "dcw_wavelet"):
        if k in s:
            dcw[k] = s[k]
    payload.update(dcw)
    return payload
