"""8.0-m3d — the /release_task payload builder, and the one rule it exists to enforce.

🔴 NEVER INHERIT AN ACE-STEP DEFAULT.

ACE-Step's HTTP request model and its pipeline dataclass disagree on six fields, and the request
model is not the one that renders. So an omitted parameter does not name one behavior — it names
whichever of two values is reached first:

    shift 3.0 vs 1.0 · thinking False vs True · audio_format mp3 vs flac
    allow_lm_batch True vs False · lm_cfg_scale 2.5 vs 2.0 · batch_size None->2

A field left out is a field whose value cannot be stated. These specs pin every one of them, plus
the ones keyed on the CARD's model rather than on anything the form says.

⚠️ `shift` IS BOTH: divergent AND model-driven, and it took a while to notice the second half.
Picking the pipeline's 1.0 over the request model's 3.0 satisfies the rule above and was still
wrong for turbo, which upstream says wants 3.0 — so "do not inherit a default" is necessary and
not sufficient. It has its own spec below rather than a row in the flat table, because a table of
one-value-per-field cannot express an answer that depends on the card.
"""
import pytest

from vocalis.runtime import acegen

TURBO = "acestep-v15-turbo"
SFT = "acestep-v15-xl-sft"


def _p(**kw):
    base = {"template": {}, "settings": {}, "model": TURBO, "seed": 1}
    base.update(kw)
    return acegen.build_payload(**base)


@pytest.mark.parametrize("field,expected", [
    ("thinking", True),           # request model says False
    ("audio_format", "flac"),     # request model says mp3
    ("allow_lm_batch", False),    # request model says True
    ("lm_cfg_scale", 2.0),        # request model says 2.5; the Gradio slider agrees with 2.0
])
def test_the_six_divergent_defaults_are_sent_explicitly(field, expected):
    """🔴 THE WHOLE POINT OF THE MODULE. Each of these is a field where "leave it unset" picks a
    different value depending on which layer wins, and the pipeline's is the one that renders."""
    assert _p()[field] == expected


def test_shift_is_sent_explicitly_AND_follows_the_cards_model(monkeypatch):
    """🔴 SHIFT LEFT THE FLAT LIST ABOVE BECAUSE ITS RIGHT ANSWER DEPENDS ON THE MODEL.

    It used to be pinned at 1.0 for every card — the pipeline dataclass's value, chosen over the
    request model's 3.0 on the rule this file is named for. That rule still holds; what was wrong
    was treating 1.0 as the answer for BOTH families. Upstream is explicit that turbo wants 3.0
    (`docs/en/INFERENCE.md:361`, "the only timestep/guidance parameter you need to set manually for
    turbo is shift=3.0"), and turbo takes 8 steps, so how they are distributed matters far more
    there than it does at 50.

    ⚠️ ACE-STEP CONTRADICTS ITSELF AND THIS WAS SETTLED FROM THE CODE. Its API field description
    says shift is "Only effective for base models, not turbo models" — false:
    `modeling_acestep_v15_turbo.py:1978` applies the same `t = shift*t/(1+(shift-1)*t)` the base
    and SFT samplers do.

    📌 The DIVERGENCE invariant is unchanged and is asserted first: the key is always present, so
    neither layer's default is ever inherited. That is the part that must never regress.
    """
    for model in (TURBO, SFT, "", "some-future-model"):
        assert "shift" in _p(model=model), f"{model}: an omitted shift inherits whichever layer wins"

    assert _p(model=TURBO)["shift"] == 3.0
    assert _p(model="acestep-v15-xl-turbo")["shift"] == 3.0
    assert _p(model=SFT)["shift"] == 1.0
    assert _p(model="")["shift"] == 1.0, "an unknown model falls back to base, never to a guess"

    # And an explicit value still wins on every card — model-driven is the BLANK behavior.
    assert _p(model=TURBO, settings={"shift": 2.5})["shift"] == 2.5
    assert _p(model=SFT, settings={"shift": 2.5})["shift"] == 2.5


def test_batch_size_is_always_one_because_parallelism_is_cards():
    """🔴 GenerationConfig DEFAULTS IT TO 2. Leaving it unset silently doubles every render and
    halves the point of the second card — the queue already puts one job on each."""
    assert _p()["batch_size"] == 1
    assert _p(settings={"batch_size": 4})["batch_size"] == 1, "a setting overrode the invariant"


def test_steps_follow_the_cards_model_not_a_single_default():
    """turbo 8, xl-sft 50, from model_config.py. One default would make one of them slow or bad."""
    assert _p(model=TURBO)["inference_steps"] == 8
    assert _p(model=SFT)["inference_steps"] == 50
    assert _p(model="acestep-v15-something-else")["inference_steps"] == 32


def test_dcw_mirrors_gradios_per_model_checkbox_not_the_blanket_true():
    """🔴 THE SHARP ONE. GenerationParams defaults dcw_enabled=True for everything; Gradio sets it
    FROM THE MODEL — turbo on, xl-sft OFF. Inheriting the blanket True makes xl-sft render
    differently from how Gradio has been rendering it, and makes turbo and sft diverge by
    DIFFERENT amounts — which is exactly the pair draft-then-render needs to be comparable."""
    assert _p(model=TURBO)["dcw_enabled"] is True
    assert _p(model=SFT)["dcw_enabled"] is False


def test_dcw_is_sent_as_false_rather_than_omitted_for_sft():
    """Omitting it means True. The difference between "off" and "not mentioned" is the bug."""
    p = _p(model=SFT)
    assert "dcw_enabled" in p and p["dcw_enabled"] is False


def test_the_think_mode_scalers_swap_and_they_are_not_a_reorder():
    """⚠️ Think ON is 0.02/0.06, OFF is 0.05/0.02 — the low band DROPS and the high band RISES.
    Not the same two numbers in the other order, which is the easy way to mis-copy this."""
    on = _p(settings={"thinking": True})
    off = _p(settings={"thinking": False})
    assert (on["dcw_scaler"], on["dcw_high_scaler"]) == (0.02, 0.06)
    assert (off["dcw_scaler"], off["dcw_high_scaler"]) == (0.05, 0.02)


def test_an_explicit_dcw_setting_OVERRIDES_the_model_default():
    """🔴 THE BUG THIS MODULE SHIPPED WITH FOR TEN MINUTES, AND IT WAS INVISIBLE.

    `build_payload` applied the per-model DCW LAST, as an unconditional `payload.update(...)`, so
    an explicit `dcw_enabled` from Advanced was silently discarded. The three-state control ("on" /
    "off" / "follow the model") therefore had two working states and no error anywhere — the UI
    promising what the server does not keep, which is the exact shape this codebase keeps finding.

    Found by driving the builder, not by reading it.
    """
    assert _p(model=TURBO, settings={"dcw_enabled": False})["dcw_enabled"] is False, (
        "an explicit OFF was overwritten by turbo's model default of ON")
    assert _p(model=SFT, settings={"dcw_enabled": True})["dcw_enabled"] is True, (
        "an explicit ON was overwritten by xl-sft's model default of OFF")


def test_an_explicit_dcw_OFF_is_not_read_as_unspecified():
    """⚠️ `if s.get("dcw_enabled")` would treat False as "not specified" and fall back to the
    model default — the same bug wearing a different hat, and the reason the check is `in`."""
    assert _p(model=TURBO, settings={"dcw_enabled": False})["dcw_enabled"] is False


def test_the_scalers_can_be_overridden_too_without_touching_the_switch():
    p = _p(model=TURBO, settings={"dcw_scaler": 0.11, "dcw_mode": "low"})
    assert p["dcw_scaler"] == 0.11 and p["dcw_mode"] == "low"
    assert p["dcw_enabled"] is True, "overriding a scaler changed whether DCW runs at all"


def test_with_nothing_set_the_model_still_decides():
    """The third state, and the default one: blank means follow the card's model."""
    assert _p(model=TURBO)["dcw_enabled"] is True
    assert _p(model=SFT)["dcw_enabled"] is False


def test_the_seed_is_taken_from_the_caller_and_random_seed_is_off():
    """🔴 The caller gives each card its own. `use_random_seed` must be False or ACE-Step picks,
    and two cards can then collide on one song — or, worse, silently agree."""
    p = _p(seed=4242)
    assert p["seed"] == 4242 and p["use_random_seed"] is False


def test_instrumental_blanks_the_lyrics_rather_than_relying_on_a_flag():
    """The pipeline infers `instrumental` from the lyrics text, so a ticked box with lyrics still
    present would sing them."""
    p = _p(template={"instrumental": True, "lyrics": "[verse]\nwords"})
    assert p["lyrics"] == ""


def test_lyrics_are_sent_when_it_is_not_instrumental():
    assert _p(template={"lyrics": "[verse]\nwords"})["lyrics"] == "[verse]\nwords"


def test_an_absent_duration_is_the_auto_sentinel_not_none():
    """🔴 A NEGATIVE DURATION IS "AUTO", and it is what makes the LM choose a length from the
    lyrics. Sending None instead leaves the request model's own default in play."""
    assert _p(template={})["audio_duration"] == -1.0
    assert _p(template={"duration": 0})["audio_duration"] == -1.0
    assert _p(template={"duration": 210})["audio_duration"] == 210.0


def test_every_widened_parameter_the_overlay_exposes_is_named():
    """🔴 THE OVERLAY EXISTS TO MAKE THESE REACHABLE, so a payload that omits one silently
    reverts to a dataclass default nobody chose — which is the exact condition M0 was built to
    end. If a field is added to the overlay, it belongs here too."""
    p = _p()
    for field in ("sampler_mode", "velocity_norm_threshold", "velocity_ema_factor",
                  "dcw_enabled", "dcw_mode", "dcw_scaler", "dcw_high_scaler", "dcw_wavelet",
                  "enable_normalization", "normalization_db",
                  "fade_in_duration", "fade_out_duration",
                  "latent_shift", "latent_rescale"):
        assert field in p, f"{field} is reachable thanks to the overlay but never sent"


# ── 8.1-m1: the reference clip ──────────────────────────────────────────────────────────────

def test_the_reference_field_is_named_reference_audio_path_and_nothing_else():
    """🔴 THE NEAR-MISS NAME IS THE WHOLE HAZARD. The route's alias table accepts
    `ref_audio_path`/`referenceAudioPath`/`refAudioPath` and **silently drops any key it does not
    know** — so `reference_audio`, which the older handoff doc asks for, renders an ordinary song
    with no error anywhere. You find that by listening, not by reading a log."""
    p = _p(reference_path="/ai-output/acestep-tmp/deadbeefdeadbeef.opus")
    assert p["reference_audio_path"] == "/ai-output/acestep-tmp/deadbeefdeadbeef.opus"
    assert "reference_audio" not in p


def test_no_reference_is_the_empty_string_and_the_key_is_still_sent():
    """An empty reference path is valid and is sent explicitly; validate_audio_path treats it as no reference. Keep the field present so every job uses the same request shape."""
    p = _p()
    assert p["reference_audio_path"] == ""


def test_the_builder_takes_a_staged_path_never_the_token_the_template_holds():
    """🔴 THE SPLIT IS WHAT KEEPS THIS FUNCTION PURE. The template stores `reference: stem:<ref>`
    because a template outlives any staging directory; turning that into a real file is I/O, and
    `_dispatch` rebuilds payloads on the queue's pump where it must not block. So the token in the
    template must never leak into the payload."""
    p = _p(template={"reference": "stem:set-a"})
    assert p["reference_audio_path"] == ""


def test_settings_override_the_defaults_but_the_song_comes_from_the_template():
    """The two inputs do not overlap: `settings` is how well it renders, `template` is what it
    is. A settings key must never be able to change the song."""
    p = _p(template={"caption": "alt metal", "bpm": 85},
           settings={"guidance_scale": 9.5, "sampler_mode": "heun", "caption": "IGNORED"})
    assert p["guidance_scale"] == 9.5 and p["sampler_mode"] == "heun"
    assert p["prompt"] == "alt metal" and p["bpm"] == 85


# ── 8.1-m2b: the two LM routes speak three different dialects between them ───────────────────

def test_the_two_lm_routes_disagree_about_two_field_names_and_the_seam_fixes_it():
    """🔴 `create_sample` answers `keyscale`/`timesignature`; `format_input` answers
    `key_scale`/`time_signature`; `/query_result` uses the first spelling and calls the caption
    `prompt`. Three dialects for the same handful of fields. Normalized once, at the client seam,
    so no caller has to remember which one it is holding."""
    from vocalis.runtime import acestep as rt_ace
    assert rt_ace._as_song({"keyscale": "Am", "timesignature": "4"}) == {
        "key_scale": "Am", "time_signature": "4"}
    assert rt_ace._as_song({"key_scale": "Am", "time_signature": "4"}) == {
        "key_scale": "Am", "time_signature": "4"}
    assert rt_ace._as_song({"language": "ja"}) == {"vocal_language": "ja"}


def test_an_empty_field_is_dropped_rather_than_returned_as_a_blank():
    """⚠️ The caller writes these OVER the user's form. "The model said nothing about the key" and
    "the model wants the key cleared" are different facts, and only one of them is ever true."""
    from vocalis.runtime import acestep as rt_ace
    assert rt_ace._as_song({"caption": "x", "lyrics": "", "bpm": None}) == {"caption": "x"}


def test_a_failure_code_inside_a_200_is_still_a_failure():
    """🔴 THE SHAPE THAT WOULD HAVE READ AS AN EMPTY ANSWER. These routes wrap everything in
    `{"data": …, "code": …, "error": …}` and answer HTTP 200 even when `code` is 500 — so a client
    checking only the HTTP status reports "the LM returned nothing" for an init failure that came
    with a perfectly good message attached."""
    from vocalis.runtime import acestep as rt_ace
    import json as _json
    import urllib.request

    class _R:
        def __init__(self, body): self._b = _json.dumps(body).encode()
        def read(self): return self._b
        def __enter__(self): return self
        def __exit__(self, *a): return False

    body = {"data": None, "code": 500, "error": "LLM init failed: out of memory"}
    urlopen = lambda req, timeout=None: _R(body)
    orig, urllib.request.urlopen = urllib.request.urlopen, urlopen
    try:
        with pytest.raises(RuntimeError, match="out of memory"):
            rt_ace.create_sample("http://x", query="anything")
    finally:
        urllib.request.urlopen = orig


# ── 8.1-m3: the source-audio modes ──────────────────────────────────────────────────────────

def test_the_mode_decides_the_task_type_and_nothing_else_branches_on_it():
    """🔴 ONE FIELD CHANGES. The header's rule is that every parameter is sent on every job, and a
    payload whose SHAPE changed per mode would break that — a repaint range on a text2music render
    is simply ignored by the pipeline, and sending it costs nothing next to a payload you cannot
    state the contents of."""
    for mode, task in (("custom", "text2music"), ("simple", "text2music"), ("remix", "cover"),
                       ("remix-nofsq", "cover-nofsq"), ("repaint", "repaint"),
                       ("extract", "extract"), ("lego", "lego"), ("complete", "complete")):
        assert _p(template={"mode": mode})["task_type"] == task
    base = set(_p(template={"mode": "custom"}))
    assert set(_p(template={"mode": "repaint"})) == base, (
        "the payload grew or shrank with the mode — every field is sent on every job")


def test_an_unknown_mode_falls_back_rather_than_passing_a_string_through():
    """⚠️ `task_type` IS A BARE `str` ON THE REQUEST MODEL, not a Literal — an unsupported value is
    not rejected at the door, it fails deeper or quietly. A stale draft naming a mode this build
    dropped must render something ordinary, not post nonsense."""
    assert _p(template={"mode": "no-such-mode"})["task_type"] == "text2music"
    assert _p(template={"mode": ""})["task_type"] == "text2music"
    assert _p()["task_type"] == "text2music"


def test_cover_nofsq_is_a_task_type_and_not_a_flag():
    """The ACE-Step request path uses no_fsq as a task type selected by the Remix mode; it is not a payload flag. Keep it in the mode mapping so the backend receives the task it handles."""
    p = _p(template={"mode": "remix-nofsq"})
    assert p["task_type"] == "cover-nofsq"
    assert "no_fsq" not in p


def test_the_source_field_is_named_src_audio_path():
    """🔴 SAME TRAP AS THE REFERENCE, SAME CONSEQUENCE. `release_task_request_builder.py`
    enumerates the names it reads, so `src_audio` is not an error — it is a Remix that renders an
    ordinary song with nothing anywhere saying the remix did not happen."""
    p = _p(source_path="/ai-output/acestep-tmp/abc.flac")
    assert p["src_audio_path"] == "/ai-output/acestep-tmp/abc.flac"
    assert "src_audio" not in p


def test_the_repaint_range_fields_do_not_share_the_repaint_prefix():
    """🔴 `repainting_start` / `repainting_end`, while the four controls beside them are
    `repaint_*`. Two different prefixes in one feature is exactly the kind of thing that gets
    typed from memory and silently ignored."""
    p = _p(template={"mode": "repaint", "repaint_start": 30.0, "repaint_end": 48.5})
    assert p["repainting_start"] == 30.0 and p["repainting_end"] == 48.5
    assert "repaint_start" not in p and "repaint_end" not in p


def test_an_absent_repaint_end_is_null_because_that_means_to_the_end():
    """⚠️ THE ONE FIELD ALLOWED TO BE NULL. `repainting_end` is `Optional[float]` upstream and
    None means "to the end of the song" — a real value. Sending 0.0 would repaint nothing."""
    p = _p(template={"mode": "repaint", "repaint_start": 30.0})
    assert p["repainting_end"] is None
    assert p["repainting_start"] == 30.0


def test_the_join_controls_are_present_because_start_and_end_alone_feel_broken():
    """Design §9: a repaint UI with only a range produces a section dropped into a song rather
    than joined to it. These are what do the joining, so they are sent on every job."""
    p = _p()
    for field in ("repaint_mode", "repaint_strength", "repaint_latent_crossfade_frames",
                  "repaint_wav_crossfade_sec", "chunk_mask_mode", "cover_noise_strength"):
        assert field in p, f"{field} is what makes a repaint sound joined, and it is not sent"
    assert p["repaint_mode"] == "balanced" and p["repaint_strength"] == 0.5


def test_cover_strength_comes_from_the_CARD_and_the_join_controls_from_advanced():
    """📌 The one split in this group, and it is deliberate. Cover strength is the creative dial of
    a remix — how much of the original survives — the way Length is for a new song. The rest is
    about how cleanly the seam is hidden, which is Advanced's whole remit."""
    p = _p(template={"mode": "remix", "cover_strength": 0.4},
           settings={"repaint_strength": 0.9, "cover_noise_strength": 0.2})
    assert p["audio_cover_strength"] == 0.4
    assert p["repaint_strength"] == 0.9 and p["cover_noise_strength"] == 0.2
    # And a settings key must not be able to reach the card's dial.
    assert _p(template={"mode": "remix"}, settings={"cover_strength": 0.1})[
        "audio_cover_strength"] == 1.0


def test_a_blank_number_box_takes_the_default_and_a_ZERO_does_not():
    """🔴 THE THREE-WAY DISTINCTION, AND TWO SHORTER SPELLINGS EACH LOSE ONE OF THE THREE.

    An empty number input submits `null`, so `t.get("cover_strength", 1.0)` hands back the None it
    FOUND rather than the default — a TypeError in `float()`, which is how this arrived: as a 500
    on a real Generate press, caught by the browser spec rather than by any of the unit tests
    above. And the obvious repair, `t.get(k) or 1.0`, breaks the most interesting value in the
    range: 0 is falsy, so "keep none of the original" would silently become "keep all of it" —
    a remix that comes out sounding like its source with nothing to explain it.
    """
    assert _p(template={"mode": "remix"})["audio_cover_strength"] == 1.0
    assert _p(template={"mode": "remix", "cover_strength": None})["audio_cover_strength"] == 1.0
    assert _p(template={"mode": "remix", "cover_strength": ""})["audio_cover_strength"] == 1.0
    assert _p(template={"mode": "remix", "cover_strength": 0})["audio_cover_strength"] == 0.0
    assert _p(template={"mode": "remix", "cover_strength": 0.35})["audio_cover_strength"] == 0.35

    assert _p(template={"mode": "repaint", "repaint_start": None})["repainting_start"] == 0.0
    assert _p(template={"mode": "repaint", "repaint_start": 0})["repainting_start"] == 0.0
    assert _p(template={"mode": "repaint", "repaint_start": 12.5})["repainting_start"] == 12.5


def test_a_hand_edited_template_does_not_500_a_press():
    """A knob is not an instruction — same reasoning as `_seed_for`'s clamp. A stale draft or a
    hand-edited store must render something, not fail a press that took a paragraph of lyrics."""
    p = _p(template={"mode": "remix", "cover_strength": "loud"})
    assert p["audio_cover_strength"] == 1.0


# ── 8.1-m4: the track modes ─────────────────────────────────────────────────────────────────

def test_extract_and_lego_send_ONE_track_and_complete_sends_a_LIST():
    """🔴 THE DESIGN CALLS THIS ONE PICKER AND UPSTREAM HAS TWO FIELDS.
    `_resolve_instruction` calls `.upper()` on `track_name` and `" | ".join(...)` on
    `track_classes` — send a list where a name belongs and `.upper()` gets a list; send a name
    where a list belongs and the join spells it one character at a time. Neither is a validation
    error, and both end up inside the prompt the model reads."""
    for mode in ("extract", "lego"):
        p = _p(template={"mode": mode, "tracks": ["vocals"]})
        assert p["track_name"] == "vocals"
        assert p["track_classes"] is None
    p = _p(template={"mode": "complete", "tracks": ["guitar", "bass"]})
    assert p["track_classes"] == ["guitar", "bass"]
    assert p["track_name"] is None


def test_a_singular_mode_handed_several_takes_the_first_rather_than_a_list():
    """The radio makes this unreachable from the UI; a hand-edited template or an older draft
    makes it reachable from the store, and a list in `.upper()` is a 500 on someone's press."""
    p = _p(template={"mode": "extract", "tracks": ["drums", "bass"]})
    assert p["track_name"] == "drums"


def test_an_unknown_track_is_dropped_rather_than_passed_into_the_prompt():
    """⚠️ THE VALUE ENDS UP IN THE PROMPT THE MODEL READS — "Complete the input track with
    GUITAR | BASS:". A typo does not fail; it asks for an instrument that does not exist and
    quietly gets something else. Filtered against upstream's own TRACK_NAMES."""
    assert _p(template={"mode": "complete", "tracks": ["guitar", "kazoo"]})[
        "track_classes"] == ["guitar"]
    assert _p(template={"mode": "extract", "tracks": ["kazoo"]})["track_name"] is None


def test_no_track_picked_is_None_so_upstream_uses_its_default_instruction():
    """📌 EMPTY IS A REAL ANSWER, NOT AN UNFILLED FORM. Upstream falls back to `extract_default`
    ("Extract the track from the audio:") when the field is falsy — so "you choose" is a thing the
    user can actually ask for. ⚠️ None rather than "": an empty string takes the SAME truthiness
    branch a name does in some readings, and `""` formatted into {TRACK_NAME} is worse than the
    default sentence."""
    for mode in ("extract", "lego"):
        assert _p(template={"mode": mode})["track_name"] is None
        assert _p(template={"mode": mode, "tracks": []})["track_name"] is None
    assert _p(template={"mode": "complete", "tracks": []})["track_classes"] is None


def test_a_mode_that_takes_no_tracks_sends_neither_even_if_the_draft_has_some():
    """Switching Complete -> Custom leaves the ticks in the draft. They must not ride along."""
    p = _p(template={"mode": "custom", "tracks": ["guitar"]})
    assert p["track_name"] is None and p["track_classes"] is None


def test_the_instruction_is_never_sent_because_that_is_what_resolves_the_track():
    """🔴 `_resolve_instruction` only fills the template in when the incoming instruction is EMPTY
    or exactly the default. An explicit one — even a well-meant one assembled from the picker —
    silently overrides the track machinery and the model is never told which track it is on. The
    older handoff doc asks for exactly that; the structured fields exist so nobody has to."""
    assert "instruction" not in _p(template={"mode": "extract", "tracks": ["vocals"]})


def test_duplicate_ticks_collapse_because_the_join_would_repeat_them():
    p = _p(template={"mode": "complete", "tracks": ["bass", "bass", "drums"]})
    assert p["track_classes"] == ["bass", "drums"]


# ── 8.1-m7: the rest of the Advanced surface, and the three fields that do not exist ─────────

def test_the_remaining_lm_knobs_are_sent():
    p = _p(settings={"lm_top_k": 40, "constrained_decoding": False,
                     "lm_batch_chunk_size": 16, "timesteps": "0.9,0.5,0.1,0"})
    assert p["lm_top_k"] == 40
    assert p["constrained_decoding"] is False
    assert p["lm_batch_chunk_size"] == 16
    assert p["timesteps"] == "0.9,0.5,0.1,0"


def test_their_defaults_match_the_request_model():
    p = _p()
    assert p["lm_top_k"] is None, "None means no cap, which is upstream's default"
    assert p["constrained_decoding"] is True
    assert p["lm_batch_chunk_size"] == 8
    assert p["timesteps"] is None, (
        "None, not '' — a blank string is a value the parser would try to read, and this one "
        "OVERRIDES both inference_steps and shift when set")


@pytest.mark.parametrize("phantom", ["score_sensitivity", "autogen", "use_cot_metas"])
def test_three_of_the_designs_remaining_fields_are_not_fields_at_all(phantom):
    """🔴 CHECKED AGAINST THE REQUEST BUILDER, NOT THE DATACLASS, AND THAT IS THE WHOLE LESSON.

    Design §9 lists all three under "Advanced — what is missing". Measured on the checkout:

      score_sensitivity  exists ONLY in `acestep/ui/gradio/interfaces/…` — a Gradio control with
                         no backend parameter behind it anywhere.
      autogen            not an API field at all; Gradio's own generate-row toggle.
      use_cot_metas      real on GenerationParams, but the API DERIVES it (`= not sample_mode`)
                         and never reads it from a request.

    Adding a control for any of them would be a knob that moves nothing, silently — which is the
    single failure mode this whole module is written against. Pinned so a future session reading
    §9 as a checklist does not helpfully put them back.
    """
    assert phantom not in _p(settings={phantom: True})


def test_a_blank_timesteps_does_not_disable_steps_and_shift():
    """⚠️ It OVERRIDES both when set, so an empty box leaking through as "" would silently make
    Steps and Timestep shift stop meaning anything."""
    p = _p(settings={"timesteps": ""})
    assert p["timesteps"] is None
    assert p["inference_steps"] == 8 and p["shift"] == 3.0


# ACE-Step's request model and builder forward retake_* and flow_edit_* to GenerationParams and inference. Keep these supported fields in the builder rather than treating them as dropped request options.


def test_retake_and_edit_are_text2music_with_an_overlay():
    """Neither is a task type. Retake perturbs the noise; Edit integrates a delta over it."""
    assert _p(template={"mode": "retake"})["task_type"] == "text2music"
    assert _p(template={"mode": "edit"})["task_type"] == "text2music"


def test_a_retake_defaults_to_a_NON_ZERO_variance():
    """🔴 `inference.py:169`: "retake_variance=0 is a no-op; the retake_seed is only consumed when
    variance>0". A Retake left at zero re-renders the original exactly — a button that appears to
    have done nothing. So the default is deliberately off zero."""
    assert _p(template={"mode": "retake"})["retake_variance"] > 0


def test_an_explicit_zero_variance_is_still_honored():
    """`_num` keeps 0 meaning 0, for anyone who wants to prove the no-op to themselves."""
    assert _p(template={"mode": "retake", "retake_variance": 0})["retake_variance"] == 0.0


def test_the_retake_seed_is_the_one_being_VARIED_not_this_jobs_own():
    """Two different seeds in one payload, and confusing them makes Retake a fresh render: `seed`
    is drawn per card so two cards do not collide, while `retake_seed` names the render being
    taken again."""
    p = _p(template={"mode": "retake", "retake_seed": 12345}, seed=999)
    assert p["retake_seed"] == 12345 and p["seed"] == 999


def test_retake_fields_are_inert_outside_retake():
    """Switching Retake -> Custom leaves the boxes filled in the draft; they must not ride along
    and silently variance-mix an ordinary render."""
    p = _p(template={"mode": "custom", "retake_variance": 0.5, "retake_seed": 7})
    assert p["retake_variance"] == 0.0 and p["retake_seed"] is None


def test_edit_sets_the_morph_flag_and_carries_what_the_song_WAS():
    """🔴 The overlay integrates V_tar(caption, lyrics) - V_src(source_caption, source_lyrics).
    Leave the source words empty and the delta is the whole target — Edit degrades into an
    ordinary render that ignores the song it was pointed at."""
    p = _p(template={"mode": "edit", "caption": "now a waltz",
                     "edit_from_caption": "was a march", "edit_from_lyrics": "old words"})
    assert p["flow_edit_morph"] is True
    assert p["flow_edit_source_caption"] == "was a march"
    assert p["flow_edit_source_lyrics"] == "old words"
    assert p["prompt"] == "now a waltz", "the caption above is the TARGET, not the source"


def test_the_morph_flag_is_off_everywhere_else():
    for mode in ("custom", "simple", "retake", "remix", "repaint"):
        assert _p(template={"mode": mode})["flow_edit_morph"] is False


def test_edit_needs_a_source_and_retake_does_not():
    """🔴 THE ASYMMETRY IS UPSTREAM'S. `inference.py:839-846` passes `src_audio` on a text2music
    job ONLY when `flow_edit_morph` is set — the overlay needs it to form zt_src/zt_tar. So Edit
    is the one text2music mode that must refuse without one, while Retake needs no audio at all:
    it perturbs the noise of a song described by the same words."""
    assert "edit" in acegen.MODES_NEEDING_SOURCE
    assert "retake" not in acegen.MODES_NEEDING_SOURCE


def test_the_morph_window_is_sent_with_upstreams_defaults():
    p = _p()
    assert p["flow_edit_n_min"] == 0.0 and p["flow_edit_n_max"] == 1.0
    assert p["flow_edit_n_avg"] == 1
    q = _p(settings={"flow_edit_n_min": 0.2, "flow_edit_n_max": 0.8, "flow_edit_n_avg": 3})
    assert (q["flow_edit_n_min"], q["flow_edit_n_max"], q["flow_edit_n_avg"]) == (0.2, 0.8, 3)


def test_a_failure_reason_that_only_arrives_in_progress_text_reaches_the_job():
    """🔴 2026-10-09, M1 on the AMD test host: ACE's VRAM pre-flight refused a render with status 2,
    an empty result list, and the reason only in `progress_text`. The job said "the backend reported
    status 2" and nothing else, so a full card looked like a broken install."""
    from vocalis.runtime import acestep as rt_ace
    import json as _json
    import urllib.request

    class _R:
        def __init__(self, body): self._b = _json.dumps(body).encode()
        def read(self): return self._b
        def __enter__(self): return self
        def __exit__(self, *a): return False

    row = {"task_id": "t", "status": rt_ace.FAILED,
           "result": _json.dumps([{"file": "", "status": 2, "progress": 0.0, "stage": "failed"}]),
           "progress_text": "10:08:06 | WARNING | [generate_music] VRAM pre-flight failed: "
                            "Insufficient free VRAM: need ~0.8 GB, only 0.1 GB available."}
    orig, urllib.request.urlopen = urllib.request.urlopen, lambda req, timeout=None: _R({"data": [row]})
    try:
        r = rt_ace.poll("http://x", "t")
    finally:
        urllib.request.urlopen = orig
    assert r["status"] == rt_ace.FAILED
    assert r["error"] == ("VRAM pre-flight failed: Insufficient free VRAM: need ~0.8 GB, "
                          "only 0.1 GB available.")

    # A running job's progress text is progress, not an error.
    row = {**row, "status": rt_ace.RUNNING}
    orig, urllib.request.urlopen = urllib.request.urlopen, lambda req, timeout=None: _R({"data": [row]})
    try:
        assert rt_ace.poll("http://x", "t")["error"] is None
    finally:
        urllib.request.urlopen = orig


# ── every model the music page names is one setup downloads (October 11, 2026) ─────────────────
# The model menu lists only what is on disk and nothing is downloaded at run time, so a model the
# page has defaults for must be in the ACE-Step lock or the page promises a model that cannot load.
# The page is designed around two: turbo for drafts and xl-sft for finished renders, and Extract,
# Replace and Complete only run on xl-sft (turbo reports no such task types).
# SUPERSEDED the same day: the publisher lists Extract, Replace (lego) and Complete for
# acestep-v15-xl-base ALONE; xl-sft is "Standard" (see acegen.PUBLISHED_TASKS). So three models are
# downloaded: turbo (drafts), xl-sft (finished songs) and xl-base (the three editing modes).

def _acestep_lock():
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parents[3]
    path = root / "packaging" / "models" / "acestep" / "model-file-lock.json"
    if not path.is_file():                      # a checkout of the application source alone
        pytest.skip("the packaging lock is not in this checkout")
    return root, json.loads(path.read_text(encoding="utf-8"))


def test_every_model_the_music_page_has_defaults_for_is_in_the_acestep_lock():
    _root, lock = _acestep_lock()
    folders = {f["path"].split("/", 1)[0] for f in lock["selection"]["files"] if "/" in f["path"]}
    for model in (*acegen._STEPS, *acegen._DCW_OFF):
        assert model in folders, f"{model} has page defaults but setup does not download it"
    assert {TURBO, SFT} <= folders


def test_the_models_named_in_the_pages_javascript_are_downloaded_or_only_a_default_table_entry():
    """advanced.js names models in its per-model default tables. Each is either a folder setup downloads
    or `acestep-v15-xl-turbo`, which appears only in the shift default (shift 3 for the two turbo models)
    and is never offered: the menu is the folder scan, and that folder is not in the lock."""
    import re
    root, lock = _acestep_lock()
    folders = {f["path"].split("/", 1)[0] for f in lock["selection"]["files"] if "/" in f["path"]}
    js = (root / "source" / "vocalis" / "src" / "webui" / "js" / "ace" / "advanced.js").read_text(encoding="utf-8")
    named = set(re.findall(r"acestep-v15-[a-z0-9-]*[a-z0-9]", js))
    assert named, "the page names no model; this test is stale"
    assert named - folders <= {"acestep-v15-xl-turbo"}, sorted(named - folders)


def test_the_language_model_the_image_selects_is_in_the_lock():
    """ACESTEP_LM_MODEL_PATH in the image names the one language-model folder the engine loads."""
    import re
    root, lock = _acestep_lock()
    dockerfile = (root / "packaging" / "main-cuda" / "Dockerfile.app").read_text(encoding="utf-8")
    lm = re.search(r"^\s+ACESTEP_LM_MODEL_PATH=(\S+?)(?: \\)?$", dockerfile, re.MULTILINE).group(1)
    assert any(f["path"].startswith(lm + "/") for f in lock["selection"]["files"]), lm


def test_the_lock_has_the_files_xl_sft_needs_to_load_and_to_offer_every_task():
    _root, lock = _acestep_lock()
    paths = {f["path"] for f in lock["selection"]["files"] if f["path"].startswith(SFT + "/")}
    need = {"config.json", "configuration_acestep_v15.py", "modeling_acestep_v15_xl_base.py",
            "model.safetensors.index.json", "silence_latent.pt",
            *(f"model-0000{n}-of-00004.safetensors" for n in range(1, 5))}
    assert {f"{SFT}/{n}" for n in need} <= paths


BASE = "acestep-v15-xl-base"
ENGINE_ALL = ["text2music", "repaint", "cover", "cover-nofsq", "extract", "lego", "complete"]
ENGINE_STANDARD = ["text2music", "repaint", "cover", "cover-nofsq"]


def test_the_lock_has_the_files_xl_base_needs_to_load_and_to_offer_every_task():
    """October 11, 2026: the model the publisher lists for Extract, Replace and Complete is downloaded
    from the publisher's repository at a pinned revision, with the same eleven files as xl-sft."""
    _root, lock = _acestep_lock()
    files = {f["path"]: f for f in lock["selection"]["files"] if f["path"].startswith(BASE + "/")}
    need = {"config.json", "configuration_acestep_v15.py", "modeling_acestep_v15_xl_base.py",
            "model.safetensors.index.json", "silence_latent.pt", "README.md", "apg_guidance.py",
            *(f"model-0000{n}-of-00004.safetensors" for n in range(1, 5))}
    assert {f"{BASE}/{n}" for n in need} == set(files)
    assert all(f["url"].startswith("https://huggingface.co/ACE-Step/acestep-v15-xl-base/resolve/"
                                   "220c1166efbdd9583eafcb12eb160594bbfcb241/") for f in files.values())
    assert {f["expectedHash"]["algorithm"] for p, f in files.items() if "/model-0000" in p} == {"sha256"}


# ── which tasks each model may be asked to run: the publisher's table, not the engine's flag ────

def test_the_engine_flag_cannot_tell_xl_sft_from_xl_base_but_the_table_can():
    """🔴 The two models ship a byte-identical config.json (the lock records the same Git blob for it),
    so the engine's is_turbo check offers all seven tasks to both. The publisher lists the three editing
    tasks for xl-base alone."""
    _root, lock = _acestep_lock()
    blob = {f["path"]: f["expectedHash"]["value"] for f in lock["selection"]["files"]
            if f["path"].endswith("/config.json")}
    assert blob[f"{SFT}/config.json"] == blob[f"{BASE}/config.json"], "the premise of the table has changed"
    assert acegen.narrow_tasks(SFT, ENGINE_ALL) == ENGINE_STANDARD
    assert acegen.narrow_tasks(BASE, ENGINE_ALL) == ENGINE_ALL
    assert acegen.narrow_tasks(TURBO, ENGINE_STANDARD) == ENGINE_STANDARD


@pytest.mark.parametrize("task", ["extract", "lego", "complete"])
def test_only_xl_base_may_run_the_editing_tasks(task):
    assert acegen.published_models_for(task) == [BASE]
    assert acegen.models_by_task()[task] == [BASE]
    for model in (TURBO, SFT, "acestep-v15-xl-turbo"):
        assert task not in acegen.narrow_tasks(model, ENGINE_ALL), model


def test_normal_generation_cover_and_repaint_stay_with_every_model():
    for model in (TURBO, SFT, BASE):
        got = acegen.narrow_tasks(model, ENGINE_ALL)
        assert {"text2music", "cover", "cover-nofsq", "repaint"} <= set(got), model


def test_an_unknown_model_keeps_the_engines_own_answer_and_an_empty_report_stays_empty():
    assert acegen.narrow_tasks("acestep-v15-something-else", ENGINE_ALL) == ENGINE_ALL
    assert acegen.narrow_tasks("acestep-v15-something-else", ENGINE_STANDARD) == ENGINE_STANDARD
    assert acegen.narrow_tasks("acestep-v15-something-else", []) == []
    assert acegen.narrow_tasks("", None) == []
    # A model in the table never gains a task the engine did not report (the engine is believed when it says no).
    assert acegen.narrow_tasks(BASE, ENGINE_STANDARD) == ENGINE_STANDARD
    assert acegen.narrow_tasks(BASE, []) == []


def test_xl_base_steps_follow_its_model_card():
    """The card's architecture table says "Inference steps | 50 (with CFG)"; shift and DCW stay at the
    base defaults because the card gives no value for either."""
    assert acegen.steps_for(BASE) == 50
    assert acegen.shift_for(BASE) == 1.0
    assert acegen.dcw_for(BASE, thinking=False)["dcw_enabled"] is True
