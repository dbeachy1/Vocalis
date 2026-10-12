// ace/advanced.js — the generic render settings, collapsed by default (8.0-m3i, §2 goal 1).
//
// Generic render settings stay in this collapsed section rather than in song templates.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THESE ARE HOW WELL IT RENDERS, NEVER WHAT THE SONG IS.
//
// The split is §4.5.2's and it is the reason this file exists separately from ace/form.js: a
// template must be draftable on turbo and renderable on xl-sft, so anything that changes with
// the RENDER rather than with the SONG lives here and applies to whatever is generated next.
// Nothing in this file is ever written to a template.
//
// 🔴 AND EVERY ONE OF THEM IS SENT ON EVERY JOB WHETHER TOUCHED OR NOT. `runtime/acegen.py` has
// the full argument: ACE-Step's request model and its pipeline dataclass DISAGREE on six fields,
// so an unset parameter does not name one behavior. What this panel changes is the value; it
// never decides whether the field is sent.
//
// ⚠️ BLANK MEANS "USE THE MODEL'S DEFAULT", NOT ZERO. Steps and DCW are model-driven — turbo 8
// with DCW on, xl-sft 50 with it off — and the card decides which model, so leaving these empty
// is how you get the right value per card. A UI that pre-filled them with one number would make
// every render use the wrong one for one of the two cards, silently.
//
// 📌 Persisted through `UIS`, the vault-backed ui-state blob, because that is where every other
// tab's knobs live and it is already debounced and encrypted. No new store, no new route.

import { $, esc } from '../util/dom.js';
import { UIS } from '../util/uistate.js';

//: [key, label, kind, attrs, hint, dflt]. Data rather than markup because three things walk it —
//: painting, reading and restoring — and three hand-written copies is how one silently stops
//: covering a field.
//:
//: ⚠️ THAT LIST SAID FIVE FIELDS UNTIL 8.3 AND THERE HAVE ALWAYS BEEN SIX — `dflt` is read by
//: `field()` and by `aceAdvApplyDefaults`. Exactly the drift the table exists to prevent, in the
//: comment describing the table.
/** One typed ACE-Step advanced-control row.
 * * @typedef {readonly [key: string, label: string, kind: string, attrs: string, hint: string,
 *                     dflt: string|boolean]} AceKnob
 */

/** @type {ReadonlyArray<AceKnob>} */
const KNOBS = [
  // 🔴 THE SEED IS FIRST, AND BLANK IS NOT A MISSING VALUE — IT IS THE NORMAL ONE.
  // An explicit seed makes a render reproducible; showing candidate seeds without allowing one
  // to be entered would leave the value unusable.
  // ⚠️ SETTING IT MAKES BOTH CARDS RENDER THE SAME SONG, and that is why it is not the default.
  // Generate draws one seed PER CARD precisely so a two-card box is not a one-card box rendering
  // twice; pinning one overrides that deliberately, which is right for "re-render this exact song
  // with one word changed" and wrong for "give me two takes". The hint says so rather than the
  // code quietly compensating.
  // 📌 A seed only means anything against the SAME MODEL — the same number on turbo and on xl-sft
  // are unrelated renders — which is the other reason it lives here, beside the render knobs,
  // rather than on the template.
  // 🔴 AND THE PROMISE BELOW HAS ONE EXCEPTION, WHICH IS WHY IT IS SPELLED OUT RATHER THAN LEFT
  // TO BE DISCOVERED. `process_reference_audio` samples three 10-second windows with
  // `random.randint`, and Python's RNG is NEVER SEEDED in ACE-Step's inference path — the only
  // `random.seed` calls in the whole package are inside a dead `test_forward(model, seed=42)`
  // harness. Production seeds torch and nothing else. So "the same seed re-renders the same song"
  // is true right up until a reference clip is attached, and then it is simply false. A hint that
  // keeps making the promise is worse than no hint: it is the reason someone spends an evening
  // wondering why their reproducible render stopped reproducing.
  [
    'seed',
    'Seed',
    'num',
    'min="0" max="2147483646" step="1"',
    'The starting noise the render is denoised from. Blank = a fresh random one per card, which is what makes two cards give you two different takes.\n\nSet one to reproduce a candidate: the same seed, model and settings re-render the same song, so you can change one word of the lyrics and hear only that change. How far it drifts scales with how much you changed — a word inside a verse usually keeps the song recognizably itself, a rewritten chorus does not.\n\n⚠️ A seed only means anything against the SAME model; the same number on turbo and on xl-sft are unrelated renders. And with one set, both cards render the same song unless they hold different models.\n\n🔴 A reference clip ("Sing it like" on the song card) BREAKS this. ACE-Step picks three random 10-second windows out of the clip and never seeds the random number generator that picks them, so the same seed gives a different render every time one is attached. Clear the reference to get reproducibility back.',
    'random',
  ],
  [
    'inference_steps',
    'Steps',
    'num',
    'min="1" max="200" step="1"',
    "How many denoising passes the diffusion makes. More = more detail and more time; the returns fall off well before the top of the range.\n\nBlank = the card's model decides, which is almost always what you want: turbo 8, xl-sft and xl-base 50, anything else 32. Turbo is distilled to reach in 8 steps what a base model needs 50 for, so a number that suits one is badly wrong for the other.\n\n⚠️ One number here is used on BOTH cards. That is fine while they hold the same model, and wrong for one of them the moment they do not.",
    '8 turbo · 50 xl-sft, xl-base · 32 other',
  ],
  [
    'guidance_scale',
    'Guidance',
    'num',
    'min="0" max="30" step="0.1"',
    'How hard the render is steered toward your caption and lyrics. Each step runs the model twice — once conditioned on your words, once on nothing — and the difference between the two is what does the steering. 1.0 means no steering at all.\n\n📌 NOT plain CFG, which matters when you turn it up. ACE-Step applies APG: the difference is smoothed across steps, its magnitude is capped, and only the part POINTING AWAY from the conditional prediction is used. That last step is what stops a high number from simply inflating everything, which is how ordinary CFG goes harsh and lifeless. So this is safer to push than the usual advice suggests.\n\nDefault 7.0. Turbo ignores it entirely and logs that it did — it is distilled to render without guidance.',
    '7',
  ],
  [
    'shift',
    'Timestep shift',
    'num',
    'min="0.1" max="5" step="0.1"',
    'Skews the noise schedule so the steps are not spread evenly: t → shift·t / (1 + (shift−1)·t). Above 1.0 spends more of them at high noise, where the arrangement and structure are decided; below 1.0 spends more at low noise, on detail and texture.\n\nBlank = the card\'s model decides, like Steps: 1.0 for base and SFT, 3.0 for turbo. Turbo takes only 8 steps, so how they are distributed matters far more than it does at 50.\n\n⚠️ ACE-Step\'s own API says this is "only effective for base models, not turbo". That is false — its turbo sampler applies the same transform, and its documentation says to set 3.0 there. Resolved from the code.',
    '1 base/sft · 3 turbo',
  ],
  // ⚠️ "byte-identical audio every time" USED TO BE UNQUALIFIED HERE, and it was the stronger of
  // the two false promises — it named the guarantee explicitly. Same cause as the Seed hint above:
  // ode's own path is deterministic, but the reference-audio windows are drawn from an unseeded
  // Python RNG BEFORE the solver ever runs, so the tensor ode is handed differs per render.
  [
    'infer_method',
    'Method',
    'sel',
    'ode|sde',
    'How the denoising path is solved.\n\node is deterministic — with no reference clip attached, the same seed gives byte-identical audio every time, which is what makes the Seed box above useful.\n\nsde injects fresh noise at each step, so the same seed varies between runs. More variety, and sometimes a less "smoothed" texture, at the cost of reproducibility.\n\n🔴 A reference clip defeats ode\'s determinism whichever of these is selected — see the Seed hint. The clip is re-sampled at random on every render, so the solver starts from different conditioning each time.\n\nDefault: ode.',
    'ode',
  ],
  [
    'sampler_mode',
    'Sampler',
    'sel',
    'euler|heun',
    'The integrator that walks the denoising path.\n\neuler is first-order: one model call per step, and the standard choice.\n\nheun is a second-order predictor-corrector — it evaluates twice per step to correct its own estimate, so it follows the path more accurately but takes roughly TWICE as long for the same step count.\n\nDefault: euler.',
    'euler',
  ],
  [
    'use_adg',
    'Adaptive dual guidance',
    'chk',
    '',
    'Swaps the guidance math for a different one. Off, Guidance limits how far the steering can PUSH (it caps the magnitude and drops the part that merely inflates). On, ADG limits how far it can TURN: it measures the angle between the conditioned and unconditioned predictions and clips that rotation to 30° by default.\n\nSo the two fail differently rather than one being stronger. Worth trying when a high Guidance is following the caption but the result feels rigid.\n\nOff by default. Ignored by turbo, along with Guidance and the two CFG boxes.',
    false,
  ],
  [
    'cfg_interval_start',
    'CFG from',
    'num',
    'min="0" max="1" step="0.05"',
    'The bottom of the noise range over which guidance is applied — and note it is NOISE, not elapsed time, so this end is the LATE part of the run. Denoising walks from 1.0 (pure noise) down to 0.0 (finished audio); guidance is on while the current level sits between this and CFG to.\n\n0.0 = keep steering right to the last step. Raise it and the final low-noise steps run unguided, which lets the model finish the detail on its own.\n\nDefault 0.0.',
    '0',
  ],
  [
    'cfg_interval_end',
    'CFG to',
    'num',
    'min="0" max="1" step="0.05"',
    'The top of that same noise range — the EARLY part of the run, where structure is decided.\n\n1.0 = steer from the very first step. Lower it and the noisiest opening steps run unguided, which loosens the arrangement while still holding the caption through the middle.\n\nThe pair is one setting: roughly 0.1–0.9 skips both extremes, which is where guidance artifacts concentrate. Default 1.0.',
    '1',
  ],
  [
    'thinking',
    'Think',
    'chk',
    '',
    'Lets the 5 Hz language model reason about the metadata and semantic codes before the diffusion stage renders any audio — it decides structure and arrangement rather than following the caption literally.\n\n⚠️ It also swaps the DCW scalers, and not by reordering them: the low band drops and the high band rises. So Think changes the sound in two ways at once, which is worth knowing when A/B-ing it.\n\nOn by default.\n\n✅ Provided BPM, key, and meter were retained in observed renders with the planner ON. Blank fields can be filled by the planner. The planner therefore complements supplied metadata.',
    true,
  ],
  // 🔴 MEASURED, NOT ASSUMED. The planner rewrites a
  // hand-tuned caption. Repeated renders with one variable changed show that the same seed and
  // the same 33-character caption came back as a 339-character prose rewrite with this ON, and
  // as nothing with it OFF. So it is worth a control rather than a footnote.
  [
    'use_cot_caption',
    'CoT caption',
    'chk',
    '',
    'Lets the 5 Hz planner rewrite your caption into its own longer description before the audio is rendered.\n\nIn controlled comparisons, this ON produced an expanded prose caption; with it OFF, no expanded caption was recorded. If you have hand-tuned a caption and want it used as written, turn this off.\n\nOn by default. Meaningless with Think off, which is what runs the planner at all.',
    true,
  ],
  [
    'lm_temperature',
    'LM temperature',
    'num',
    'min="0" max="2" step="0.05"',
    'Sampling temperature for the 5 Hz language model — the stage that writes the metadata and codes, not the audio. Higher makes its structural choices more adventurous and less predictable; lower makes them safe and repetitive.\n\nDefault 0.85.',
    '0.85',
  ],
  [
    'lm_cfg_scale',
    'LM CFG',
    'num',
    'min="0" max="10" step="0.1"',
    "Guidance strength for the 5 Hz language model, the same idea as Guidance above but applied to the stage that plans the song rather than the one that renders it.\n\nDefault 2.0 — the pipeline's value, not the request model's 2.5, which is a real disagreement inside ACE-Step rather than a typo here.",
    '2',
  ],
  [
    'lm_top_p',
    'LM top-p',
    'num',
    'min="0" max="1" step="0.05"',
    'Nucleus sampling for the 5 Hz language model: it only ever picks from the most likely tokens whose probabilities add up to this. Lower narrows the pool and makes the planning stage more conservative.\n\nDefault 0.9.',
    '0.9',
  ],
  // ── 8.1-m7: the rest of the LM surface ────────────────────────────────────────────────
  // 🔴 THREE OF THE DESIGN'S SEVEN REMAINING FIELDS ARE NOT HERE ON PURPOSE, because they are
  // not fields. `score_sensitivity` exists only inside ACE-Step's own Gradio interface files and
  // has no backend parameter; `autogen` is not an API field at all; `use_cot_metas` is real on
  // GenerationParams but the API DERIVES it (`= not sample_mode`) and never reads it from a
  // request. A control for any of them would move nothing, silently — which is the exact shape
  // this tab keeps having to fix. Checked against the request BUILDER, not the dataclass.
  [
    'lm_top_k',
    'LM top-k',
    'num',
    'min="0" max="200" step="1"',
    "Caps the planning stage to the k most likely tokens at each step. Works alongside top-p above: top-p bounds the pool by probability mass, this bounds it by count.\n\nBlank = no cap, which is the default. Small numbers make the song's structure predictable and repetitive.",
    'no cap',
  ],
  [
    'constrained_decoding',
    'Constrained decoding',
    'chk',
    '',
    "Forces the 5 Hz model's output to stay inside the grammar the pipeline expects — the section markers, the metadata shape — instead of trusting it to produce well-formed text on its own.\n\nOn by default, and the ACE-Step routes that use the LM on its own (✨ Write it for me) always turn it on. Off is for finding out whether a strange result came from the grammar or from the model.",
    true,
  ],
  [
    'lm_batch_chunk_size',
    'LM batch chunk',
    'num',
    'min="1" max="64" step="1"',
    'How many tokens the planning stage does per batched step. Bigger is faster and uses more VRAM; it does not change what is produced.\n\nDefault 8.',
    '8',
  ],
  // ⚠️ NO placeholder IN attrs — the txt branch below adds the "default …" one, and a second
  // placeholder attribute is dead markup that silently wins over it (first occurrence rules).
  // The example schedule lives in the hint instead.
  [
    'timesteps',
    'Custom timesteps',
    'txt',
    '',
    "A hand-written denoising schedule, comma-separated and descending to 0 — e.g. 0.97,0.76,0.615,0.5,0.395,0.28,0.18,0.085,0 — instead of one derived from Steps and Timestep shift.\n\n🔴 IT OVERRIDES BOTH Steps AND Timestep shift — upstream's own field description says so, so those two boxes stop meaning anything the moment this has a value in it. Leave it blank unless you are deliberately reproducing a schedule.",
    'from Steps + shift',
  ],
  [
    'lm_negative_prompt',
    'LM negative prompt',
    'txt',
    '',
    'What the planning stage should steer AWAY from, in words. It has always been sent — pinned to the literal string "NO USER INPUT", which is upstream\'s own placeholder for "nothing specified" — and this is the box that lets you say something instead.\n\nBlank sends that placeholder, which is the default behavior.',
    'NO USER INPUT',
  ],
  [
    'dcw_enabled',
    'DCW',
    'tri',
    '',
    "A correction applied in the wavelet domain during denoising, with separate strengths for the low and high frequency bands — it is what keeps a fast render from going muddy at the bottom or brittle at the top.\n\nBlank = follow the card's model, which is what ACE-Step's own UI does: ON for turbo, OFF for xl-sft. Forcing it either way makes your renders diverge from that baseline, so blank is the honest default.",
    'on turbo · off xl-sft',
  ],
  [
    'enable_normalization',
    'Normalize',
    'chk',
    '',
    'Loudness-normalizes the finished audio to the Target dB below, so takes are comparable at the same volume instead of one just sounding better for being louder.\n\nOn by default.',
    true,
  ],
  [
    'normalization_db',
    'Target dB',
    'num',
    'min="-30" max="0" step="0.5"',
    'What Normalize aims for, in dB below full scale. 0 is the loudest possible and risks clipping; more negative leaves more headroom.\n\nDefault −1.0. Does nothing unless Normalize is ticked.',
    '-1',
  ],
  [
    'fade_in_duration',
    'Fade in',
    'num',
    'min="0" max="10" step="0.1"',
    'Seconds of fade at the start of the finished song. 0 = none, which is the default — the model usually starts cleanly, so this is for the times it does not.',
    '0',
  ],
  [
    'fade_out_duration',
    'Fade out',
    'num',
    'min="0" max="10" step="0.1"',
    'Seconds of fade at the end. 0 = none (default). Worth a second or two when a render runs into its duration limit mid-phrase rather than ending.',
    '0',
  ],
  // ── 8.2.5: the repaint-join and flow-edit knobs the mode hints have promised all along ────
  // 🔴 THE REPAINT HINT SAID "Repaint mode, Repaint strength and the two crossfades in
  // ⚙ Advanced" AND NONE OF THEM EXISTED — acegen has read every one of these from `settings`
  // since m3/m5 (explicit defaults sent, so payloads were correct), but the panel never grew the
  // boxes: a documented control that is not there is this tab's cardinal sin pointed the other
  // way. Values and bounds come from the request model (`release_task_models.py:56-83,141-143`).
  [
    'repaint_mode',
    'Repaint mode',
    'sel',
    'conservative|balanced|aggressive',
    'How much of the source survives inside the repainted range.\n\nconservative keeps the maximum of the source; aggressive is pure diffusion (the range is fully re-imagined); balanced sits between and is the only mode that reads Repaint strength.\n\nDefault: balanced.',
    'balanced',
  ],
  [
    'repaint_strength',
    'Repaint strength',
    'num',
    'min="0" max="1" step="0.05"',
    'Balanced-mode intensity: 0 leans conservative (maximum source preservation), 1 leans aggressive (pure diffusion).\n\n⚠️ Read ONLY while Repaint mode is balanced — the other two modes ignore it.\n\nDefault 0.5.',
    '0.5',
  ],
  [
    'repaint_latent_crossfade_frames',
    'Latent crossfade',
    'num',
    'min="0" max="100" step="1"',
    'How wide the latent-level blend is at each boundary of the repainted range, in 25 Hz frames — 10 is about 0.4 s. Wider joins more smoothly and eats further into the untouched audio.\n\nDefault 10.',
    '10',
  ],
  [
    'repaint_wav_crossfade_sec',
    'Wave crossfade',
    'num',
    'min="0" max="5" step="0.05"',
    'A waveform-level splice crossfade at the same boundaries, in seconds. 0 is a hard cut, which is the default — the latent blend above usually carries the join on its own.',
    '0',
  ],
  [
    'cover_noise_strength',
    'Remix noise',
    'num',
    'min="0" max="1" step="0.05"',
    'How the starting noise of a Remix or Repaint is blended: 0 starts from pure noise, 1 starts closest to the source audio.\n\nDefault 0 — Keep original on the card is the creative dial; this one shapes the join.',
    '0',
  ],
  [
    'chunk_mask_mode',
    'Chunk mask',
    'sel',
    'auto|explicit',
    'How the conditioning mask over the source is built for the source-audio modes. auto lets the pipeline decide (default); explicit uses exactly the range you gave.\n\nDefault: auto.',
    'auto',
  ],
  [
    'flow_edit_n_min',
    'Edit n-min',
    'num',
    'min="0" max="1" step="0.05"',
    'The bottom of the noise range ✏️ Edit integrates over. Raising it leaves the lowest-noise detail of the original untouched.\n\nDefault 0.',
    '0',
  ],
  [
    'flow_edit_n_max',
    'Edit n-max',
    'num',
    'min="0" max="1" step="0.05"',
    "The top of that range. Lowering it keeps the original's large-scale structure out of reach of the morph.\n\nDefault 1.",
    '1',
  ],
  [
    'flow_edit_n_avg',
    'Edit n-avg',
    'num',
    'min="1" max="10" step="1"',
    'How many noise samples ✏️ Edit averages per step when forming the morph direction. More is steadier and slower.\n\nDefault 1.',
    '1',
  ],
];

/** @param {string} k */
const K = k => 'vocalis-ace-adv-' + k;

/** @param {AceKnob} knob */
function field(knob) {
  const [key, label, kind, attrs, hint, dflt] = knob;
  const v = UIS.getItem(K(key));
  const t = hint ? ` title="${esc(hint)}"` : '';
  if (kind === 'chk') {
    // 🔴 AN UNSET CHECKBOX SHOWS THE REAL DEFAULT, WHICH FOR TWO OF THESE IS *ON*.
    // Every checkbox here rendered unchecked when nothing was stored, so Think and Normalize —
    // both of which `acegen` defaults to True — displayed the exact opposite of what the render
    // was doing. The behavior was right (a blank is omitted from the payload, so the server's
    // True applied), but an unchecked display was misleading. Keep these controls omitted from
    // the payload so the backend defaults remain authoritative.
    const on = v === null || v === '' ? dflt === true : v === 'true';
    return `<label class="chk"${t}><input type="checkbox" class="aceadv" data-k="${key}"${on ? ' checked' : ''}> ${esc(label)}</label>`;
  }
  if (kind === 'tri') {
    // 🔴 THREE STATES, and the third is the important one: "follow the card's model". A plain
    // checkbox has no way to say that, and defaulting it either way overrides a per-model value
    // that Gradio has been getting right for both models.
    return `<label class="acefield"${t}><span>${esc(label)}</span>
      <select class="aceadv" data-k="${key}">
        <option value=""${v ? '' : ' selected'}>default — ${esc(String(dflt))}</option>
        <option value="true"${v === 'true' ? ' selected' : ''}>always on</option>
        <option value="false"${v === 'false' ? ' selected' : ''}>always off</option>
      </select></label>`;
  }
  if (kind === 'sel') {
    const opts = attrs
      .split('|')
      .map(o => `<option value="${o}"${v === o ? ' selected' : ''}>${o}</option>`)
      .join('');
    return `<label class="acefield"${t}><span>${esc(label)}</span>
      <select class="aceadv" data-k="${key}"><option value=""${v ? '' : ' selected'}>default — ${esc(String(dflt))}</option>${opts}</select></label>`;
  }
  // 8.1-m7: a FREE-TEXT knob. Added because two of the remaining fields are strings —
  // `timesteps` is a comma-separated schedule and `lm_negative_prompt` is prose — and without
  // its own kind both would have fallen through to the number branch below, rendering as
  // <input type="number"> and being silently dropped by readAceAdvanced's Number(). Which is to
  // say: a control that looked right and sent nothing, the failure this file keeps guarding.
  if (kind === 'txt') {
    return `<label class="acefield"${t}><span>${esc(label)}</span>
      <input type="text" class="aceadv acetxt" data-k="${key}" ${attrs} value="${esc(v || '')}"
             placeholder="default ${esc(String(dflt))}"></label>`;
  }
  // 🔴 THE PLACEHOLDER NAMES THE NUMBER, NOT JUST THE WORD "default". A numeric default lets users
  // judge a change; "default" alone does not show whether 3 is a large or small adjustment.
  // or a small one. Two of these are model-driven rather than fixed, and say so.
  return `<label class="acefield"${t}><span>${esc(label)}</span>
    <input type="number" class="aceadv" data-k="${key}" ${attrs} value="${esc(v || '')}" placeholder="default ${esc(String(dflt))}"></label>`;
}

const ADV_HTML = `
<details id="aceAdv" style="margin-top:12px">
  <!-- Keep the small class for sizing; use the same accent token as the primary action for emphasis.
       Avoid backticks inside this comment because it is embedded in a template literal. -->
  <summary class="small">Advanced — how it renders. These apply to the next Generate, never to a template.</summary>
  <div class="small muted" style="margin:6px 0">Leave a box empty to use the default. ⚠️ Steps and DCW are chosen by each card's model — blank is how you get the right value on both.</div>
  <div class="aceadvgrid">${KNOBS.map(field).join('')}</div>
</details>`;

{
  const host = $('aceAdvHost');
  if (host) host.innerHTML = ADV_HTML;
}

// ── 🔴 THE THREE MODEL-DRIVEN KNOBS SHOW THE DEFAULT FOR THE MODELS ACTUALLY LOADED ────────
//
// Steps, Timestep shift and DCW have no single default: each card's model decides. The static
// text for that read "default 1 · turbo 3", which on a box running xl-sft parses as though the
// default were the string "1 · turbo 3". Show one value when loaded models agree; when they differ,
// label each value with its model.
//
// Both halves of that are right, so both are answered: when every loaded card agrees, this shows
// ONE number, because there is genuinely only one answer. When they differ — the draft-and-final
// setup this tab is built for — it names the model beside each number instead of leaving the
// reader to guess which is which. And before anything is loaded it falls back to the full table,
// still labeled.
//
// 📌 Kept in the same table as everything else `field()` walks, so a knob that becomes
// model-driven later is a row here rather than a fourth place to remember.
// 🔴 `Record<string, …>`, NOT AN INFERRED OBJECT LITERAL — `defaultTextFor` below indexes this
// with `key`, which is `AceKnob`'s first tuple slot and therefore any KNOBS key, not just these
// three. A narrower inferred type would make that lookup a TS7053 for every knob that is not
// model-driven, when the `if (!fn) return fallback` guard right there is what actually handles it.
/** @type {Record<string, (m: string) => string>} */
const PER_MODEL = {
  // 50 for xl-base too (October 11, 2026): its model card states "Inference steps | 50 (with CFG)".
  inference_steps: m => (m === 'acestep-v15-turbo' ? '8' : m === 'acestep-v15-xl-sft' || m === 'acestep-v15-xl-base' ? '50' : '32'),
  shift: m => (m === 'acestep-v15-turbo' || m === 'acestep-v15-xl-turbo' ? '3' : '1'),
  dcw_enabled: m => (m === 'acestep-v15-xl-sft' ? 'off' : 'on'),
};

//: `acestep-v15-xl-sft` -> `xl-sft`. The prefix is on every model and carries nothing.
/** @param {string} m */
const shortModel = m => String(m || '').replace('acestep-v15-', '');

/**
 * @param {string} key — a KNOBS key; only the three named in `PER_MODEL` produce anything.
 * @param {string} fallback — the knob's own `dflt`, stringified, when the model is not one of
 *   those three or nothing has loaded yet.
 * @param {string[]} models — the models the live cards report holding.
 * @returns {string}
 */
function defaultTextFor(key, fallback, models) {
  const fn = PER_MODEL[key];
  if (!fn || !models || !models.length) return fallback;
  const seen = [...new Set(models)];
  const values = [...new Set(seen.map(fn))];
  if (values.length === 1) return values[0]; // every card agrees: one honest number
  return seen.map(m => `${fn(m)} ${shortModel(m)}`).join(' · ');
}

/** @param {string[]} models */
function repaintDefaults(models) {
  for (const [key, , kind, , , dflt] of KNOBS) {
    if (!PER_MODEL[key]) continue;
    const el = document.querySelector(`.aceadv[data-k="${key}"]`);
    if (!el) continue;
    const text = defaultTextFor(key, String(dflt), models);
    if (kind === 'num') /** @type {HTMLInputElement} */ (el).placeholder = `default ${text}`;
    else {
      // The tri-state select's first option IS the default label.
      const opt = /** @type {HTMLSelectElement} */ (el).options && /** @type {HTMLSelectElement} */ (el).options[0];
      if (opt && opt.value === '') opt.textContent = `default — ${text}`;
    }
  }
}

document.addEventListener('ace:cardmodels', ev => {
  repaintDefaults((ev.detail && ev.detail.models) || []);
});

document.addEventListener('change', ev => {
  const el = ev.target;
  if (!(/** @type {Element} */ (el).classList) || !(/** @type {Element} */ (el).classList.contains('aceadv'))) return;
  const key = K(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.k));
  const v =
    /** @type {HTMLInputElement|HTMLSelectElement} */ (el).type === 'checkbox'
      ? String(/** @type {HTMLInputElement} */ (el).checked)
      : /** @type {HTMLInputElement|HTMLSelectElement} */ (el).value;
  // An empty box means "default" and must be STORED as empty rather than as 0 — `readAceAdvanced`
  // below omits empties entirely, which is what lets acegen fall back to the model-driven value.
  UIS.setItem(key, v);
});

/**
 * @param {Record<string, unknown>|null|undefined} settings — a song's recorded knobs, or
 *   `null`/`undefined` for "this row never recorded any" (pre-8.0-m9) — see the header below for
 *   why that case is NOT the same as `{}`.
 */
export function writeAceAdvanced(settings) {
  /** Put the panel back to a recorded state — what clicking a library song does (§4.5.3).
   *
   *  🔴 A KEY THAT IS ABSENT FROM `settings` IS CLEARED, NOT LEFT ALONE. That asymmetry is the
   *  whole contract: `readAceAdvanced` omits an empty box, so "absent" is precisely how the song
   *  recorded "I left this blank, follow the card's model". Skipping the missing keys would
   *  restore whatever happened to be in the box from the last song and quietly render something
   *  else — the same class of bug as a stale dropdown, one screen further along.
   *
   *  ⚠️ The store AND the control, in that order. UIS is what `readAceAdvanced` consults on the
   *  next Generate, and the control is what the user reads; setting one without the other gives
   *  a panel that renders differently from what it displays.
   */
  const s = settings || {};
  for (const [key, , kind] of KNOBS) {
    const has = Object.prototype.hasOwnProperty.call(s, key);
    const raw = !has ? '' : kind === 'chk' || kind === 'tri' ? String(!!s[key]) : String(s[key]);
    UIS.setItem(K(key), raw);
    const el = document.querySelector(`.aceadv[data-k="${key}"]`);
    if (!el) continue;
    if (/** @type {HTMLInputElement|HTMLSelectElement} */ (el).type === 'checkbox')
      /** @type {HTMLInputElement} */ (el).checked = raw === 'true';
    else /** @type {HTMLInputElement|HTMLSelectElement} */ (el).value = raw;
  }
}

/**
 * The settings object `/acestep/generate` takes. Empty boxes are OMITTED, never sent as 0 — an
 * omitted key is how acegen knows to use the card's model default.
 * @returns {Record<string, unknown>}
 */
export function readAceAdvanced() {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, , kind] of KNOBS) {
    const raw = UIS.getItem(K(key));
    if (raw === null || raw === '') continue;
    if (kind === 'chk' || kind === 'tri') out[key] = raw === 'true';
    // 🔴 `txt` BESIDE `sel`, NOT IN THE NUMBER BRANCH. `Number('0.97,0.76,…')` is NaN, so a
    // custom timestep schedule would be dropped on the floor and the render would quietly use
    // Steps instead — a knob that appears to work and does nothing.
    else if (kind === 'sel' || kind === 'txt') out[key] = raw;
    else {
      const n = Number(raw);
      if (!Number.isNaN(n)) out[key] = n;
    }
  }
  return out;
}
