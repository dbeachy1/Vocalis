// ace/form.js — the song form and its template picker (8.0-m3c, §4.5.2).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT IS IN THIS FORM IS DECIDED BY ONE RULE, AND IT IS NOT A STYLE PREFERENCE.
//
// A template holds what makes a song *that song*: the title, the lyrics, the caption, and the
// musical identity — bpm, key, time signature, language, duration, instrumental. Change any of
// them and it is a different song. Everything about how WELL it renders — steps, guidance,
// shift, sampler mode, DCW, the `lm_*` knobs, normalization, and fades are generic render
// settings; they live in Advanced rather than in song templates.
//
// 🔴 THE SEED IS ON NEITHER, and that is load-bearing rather than an omission. Generate sends one
// job per card; two cards handed the same seed render the identical song twice, which is the one
// thing a two-card setup must never do. It is per-press and never persisted.
//
// 📌 AND THERE IS NO MODEL CONTROL HERE. Which model renders is a property of the CARD (§4.5.1),
// because a backend is pinned to its card at unit start and `--device` takes no index. Putting a
// model dropdown on the form would be a second, contradictory answer to the same question.

import { $, esc } from '../util/dom.js';
import { fmtSeed } from '../util/fmt.js';
import { jget, jpost, jdel } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { readAceAdvanced, writeAceAdvanced } from './advanced.js';
// The vault-backed account store. NEVER localStorage — see the DRAFT note below.
import { UIS } from '../util/uistate.js';
import { onAceStatus } from '../sys/acestep.js';

//: The form's own fields, in the order they appear. Kept as data because three things walk it —
//: reading the form, filling it from a template, and deciding whether it is dirty — and three
//: hand-written lists of the same names is how one of them silently stops covering a field.
const FIELDS = [
  ['aceTitle', 'name'],
  ['aceCaption', 'caption'],
  ['aceLyrics', 'lyrics'],
  ['aceRef', 'reference'],
  ['aceMode', 'mode'],
  ['aceSource', 'source'],
  ['aceRepaintStart', 'repaint_start'],
  ['aceRepaintEnd', 'repaint_end'],
  ['aceCover', 'cover_strength'],
  ['aceRetakeSeed', 'retake_seed'],
  ['aceRetakeVar', 'retake_variance'],
  ['aceBpm', 'bpm'],
  ['aceKey', 'key_scale'],
  ['aceTime', 'time_signature'],
  ['aceLang', 'vocal_language'],
  ['aceDuration', 'duration'],
  ['aceInstrumental', 'instrumental'],
];

// ── 🔴 TYPES FOR WHAT readForm()/fillForm() ACTUALLY CARRY (8.3-m2) ────────────────────────────
// `AceFormData` names every key FIELDS above produces, by hand, because the loop that actually
// builds them is data-driven and cannot be checked against its own source array — TypeScript
// cannot look inside `for (const [id,key] of FIELDS)` and prove the result has exactly these
// properties. Two things keep it from drifting the way ace/advanced.js's KNOBS comment did: this
// is the ONLY place these seventeen names are written down outside FIELDS itself, and every
// reader in this file goes through readForm()'s return rather than holding the object as `any`.
//
// 🔴 A GENERIC INDEX SIGNATURE IS DELIBERATELY LEFT OFF. `fillForm` and `fieldsAgree` walk FIELDS
// by a runtime `key: string` and need one; they take `Record<string, unknown>` locally instead
// (with a narrowing cast at each generic read, one line each) so a real typo in a NAMED access
// anywhere else in this file — `f.captoin` — stays an error rather than silently becoming `unknown`.
/**
 * @typedef {object} AceFormData
 * @property {string} [name]
 * @property {string} [caption]
 * @property {string} [lyrics]
 * @property {string} [reference]
 * @property {string} [mode]
 * @property {string} [source]
 * @property {number|null} [repaint_start]
 * @property {number|null} [repaint_end]
 * @property {number|null} [cover_strength]
 * @property {string} [retake_seed]
 * @property {number|null} [retake_variance]
 * @property {number|null} [bpm]
 * @property {string} [key_scale]
 * @property {string} [time_signature]
 * @property {string} [vocal_language]
 * @property {number|null} [duration]
 * @property {boolean} [instrumental]
 * @property {string[]} tracks - always present; readForm always sets it.
 * @property {string} edit_from_caption
 * @property {string} edit_from_lyrics
 */

/**
 * A saved song template, as `/acestep/templates` returns it — `AceFormData`'s fields plus its
 * store identity. `favorite` arrives a real boolean from the route; `sortTemplates` below
 * subtracts it as a number, which is the one place the arithmetic-on-boolean idiom needed an
 * explicit `Number(...)` to stay honest under the checker — see the comment there.
 * @typedef {AceFormData & {id: string, favorite?: boolean}} AceTemplate
 */

/**
 * One "Sing it like" option — a Stems vocals clip. `duration_s` is what decides whether ACE-Step
 * can sample three distinct 10-second windows out of it; see `paintRefs`.
 * @typedef {object} AceRef
 * @property {string} token
 * @property {string} label
 * @property {number} [duration_s]
 */

/** Source option for a render; `group` selects an optgroup and `seed` controls the displayed seed.
 * * @typedef {object} AceSource
 * @property {string} token
 * @property {string} [label]
 * @property {string} group - ALWAYS sent. runtime/acestage.py sets it unconditionally for all
 *    three source kinds (:300 Library, :314 Candidates, :319 Stems). It was declared optional
 *    until 8.8-m6, which is the only reason the optgroup label needed an assertion.
 * @property {number|string} [seed]
 */

// 🔴 THE MARKUP LIVES HERE, NOT IN index.html, AND THAT IS A RULE RATHER THAN A TASTE. The page
// is under a line ceiling that has gone 11,100 -> 2,800 -> 2,000 and has NEVER once gone up; when
// a new panel does not fit, test_webui_size.py says the answer is another extraction, not another
// constant. The card rows above this form are painted the same way, by ace/cards.js.
//
// ⚠️ PAINTED AT MODULE LOAD, BEFORE THE HANDLERS BIND. Every `$(...)` below runs at import time,
// so a form painted any later would bind to nothing and fail SILENTLY — the controls would simply
// do nothing, with no error anywhere to explain it. Module scripts run after the document is
// parsed, so #aceForm already exists by the time this executes.
const FORM_HTML = `
      <div class="row" style="margin-top:10px;align-items:flex-end">
        <!-- 🔴 CAPPED, NOT flex:1. A bare flex:1 gave this select the whole row — ~1700px of
             chrome around the words "— new song —". max-width keeps it responsive on a narrow
             window while stopping it stretching; the buttons then sit beside it instead of
             marooned at the far right, and the slack after them is left empty deliberately. -->
        <div style="flex:1;min-width:240px;max-width:460px">
          <!-- 🔴 A HEADING, LIKE Mode, AND FOR THE SAME REASON. It names the thing every box
               below belongs to — which one you have
               open decides what 💾 Save writes to and what ↩ Revert changes goes back to — so it
               is not a peer of Title or BPM. The tail keeps .small so the size reads as
               hierarchy rather than as one big line. -->
          <label class="acemodehd">Song template <span class="muted small">— the lyrics, the caption and the musical details, saved under a title</span></label>
          <select id="aceTemplate"><option value="">— new song —</option></select>
        </div>
        <!-- ⚠️ nowrap: "💾 Save as…" wrapped onto two lines and made the row taller than the
             select beside it, which is what align-items:flex-end then lined up against. -->
        <div style="flex:0;display:flex;gap:6px;white-space:nowrap">
          <button id="aceTplStar" class="xs" title="Favorite this template — favorites sort to the top of the picker" disabled>☆</button>
          <button id="aceTplUpdate" class="xs" title="Save the boxes below back into the selected template, replacing what it held" disabled>💾 Save</button>
          <button id="aceTplSave" class="xs" title="Save what is in the boxes below as a NEW template, leaving the selected one alone">💾 Save as…</button>
          <!-- 🔴 THE WAY BACK, AND THERE WAS NONE. Revert changes is available whenever there are
               unsaved changes, because sometimes I need to reapply the template and I want to go
               back to it. And right now I don't see a way to do that easily."* The only way to
               undo an edit was to re-pick the template from the picker — which is the same
               action wearing a name that does not say so, and which stops for a confirm about
               losing work rather than offering to lose it on purpose.
               ⚠️ HIDDEN, NOT DISABLED, and it is the one control here that is: the others are
               permanent parts of the row whose grayed state says "pick a template first", while
               this one has nothing to say at all unless the boxes have drifted. See paintDirty.
               NOTE no backticks in this comment - one would end the template literal. -->
          <button id="aceTplRevert" class="xs" title="Put the selected template back as it was saved, throwing away the edits in the boxes below." style="display:none">↩ Revert changes</button>
          <button id="aceTplDel" class="xs danger" title="Delete the selected template. Songs already in your library are untouched." disabled>✕</button>
          <!-- 🔴 SAYS WHETHER WHAT IS ON SCREEN IS SAVED ANYWHERE. This marks unsaved edits to the
               current template, rather than leaving the saved state ambiguous.
               button."* Until now the only way to know was to remember whether you had typed
               since loading, and the guard that DOES know only speaks when you try to leave. -->
          <span id="aceTplDirty" class="acedirty" style="display:none"></span>
        </div>
      </div>

      <!-- 🔴 8.1-m3 — MODES ARE A SELECTOR ON THE CARD, NOT SUB-TABS, and upstream agrees:
           generation_tab_primary_controls.py:25 is a gr.Radio with seven choices, not a tab set.
           The reason is structural. Write song, Remix and Repaint ALL need caption, lyrics and the
           metadata row, so sub-tabs at the mode level would duplicate those fields and instantly
           owe an answer to "does editing the caption in Repaint change it in Write song?" — a
           question one card with a mode selector never has to answer.
           🔴 WHICH MODES APPEAR IS THE BACKEND'S CALL, never a guess from the model's name. Each
           card reports supported_task_types; Gradio instead sniffs the checkpoint's PATH and gets
           it wrong on some checkpoints, hiding supported modes. A mode this build
           has not implemented yet is simply absent; one the CARD cannot run is disabled with a
           tooltip naming the model, so the constraint is discoverable rather than mysterious.
           (October 11, 2026: the tooltip now names the model TO LOAD, and the per-model task list
           is the server's, narrowed to the publisher's: Extract, Replace and Complete are for
           acestep-v15-xl-base only.)
           NOTE no backticks in this comment - one would end the template literal. -->
      <!-- ⚠️ flex-basis 100%, AND THAT IS THE WHOLE "why did they stack into a column" ANSWER.
           This wrapper was flex:0 — i.e. flex 0 1 0%, basis zero and no grow — so the div
           collapsed to its MIN-CONTENT width, which for a wrapping flex row is its single widest
           button. Nine buttons then wrapped into five short rows against a flex:1 spacer that was
           holding the rest of the line empty. Give the row the full
           width is what does it; .acemodes keeps flex-wrap so a narrow window still degrades to
           two lines instead of overflowing.
           NOTE no backticks in this comment - one would end the template literal. -->
      <div class="row" style="margin-top:10px;align-items:flex-end">
        <div style="flex:1 1 100%">
          <!-- 🔴 THE ONLY LABEL ON THIS CARD THAT IS NOT GRAY-AND-SMALL, AND THE ASYMMETRY IS THE
               POINT. Every other label here names a FIELD; this one names the choice that decides
               what all of them mean, and it was rendering in the same 12px muted gray as Title.
               The tail keeps .small, so the size
               difference reads as hierarchy rather than as one big line. -->
          <label class="acemodehd">Mode <span class="muted small">— what this render DOES</span></label>
          <div id="aceModes" class="acemodes"></div>
          <input type="hidden" id="aceMode" value="custom">
        </div>
      </div>

      <!-- The source row. HIDDEN in Write song rather than dimmed, and that is the design's own
           split: §3's table separates what a mode ADDS from what it makes inert. An added field
           has nothing to show when it does not apply, while an inert one still tells you what it
           would have been — so the metadata row below dims and this disappears. -->
      <div class="row" id="aceSourceRow" style="margin-top:8px;align-items:flex-end;display:none">
        <div style="flex:1;min-width:240px;max-width:460px">
          <label>Source <span class="muted small">— the song this works FROM</span></label>
          <select id="aceSource"><option value="">— pick a song —</option></select>
        </div>
        <div style="flex:0;min-width:150px" id="aceCoverWrap">
          <label>Keep original <span class="muted small">— 0–1</span></label>
          <input type="number" id="aceCover" min="0" max="1" step="0.05" placeholder="1"
                 title="How much of the source survives the remix. 1 stays closest to the original; lower lets the model rewrite more of it.&#10;&#10;Blank = 1.">
        </div>
        <div style="flex:0;min-width:120px" id="aceRepaintFrom">
          <label>From <span class="muted small">— seconds</span></label>
          <input type="number" id="aceRepaintStart" min="0" step="0.5" placeholder="0"
                 title="Where the regenerated section starts. Everything before it is untouched.">
        </div>
        <div style="flex:0;min-width:120px" id="aceRepaintTo">
          <label>To <span class="muted small">— seconds</span></label>
          <input type="number" id="aceRepaintEnd" min="0" step="0.5" placeholder="end"
                 title="Where it stops. Blank means to the end of the song — that is a real value, not a missing one.&#10;&#10;⚠️ How cleanly the new section joins the old is set by Repaint mode, Repaint strength and the two crossfades in ⚙ Advanced. A range on its own will sound dropped in rather than joined.">
        </div>
        <div style="flex:1"></div>
      </div>

      <!-- 🔴 8.1-m4 — TWO CONTROLS WEARING ONE NAME. The design calls this "the structured track
           picker" as if it were a single thing; upstream has extract and lego take track_name
           (ONE, which gets uppercased) and complete take track_classes (a LIST, which gets
           joined). So the boxes below become radios or checkboxes with the mode, because a
           multi-select feeding a singular field would send a list into .upper().
           📌 EMPTY IS A REAL ANSWER, not an unfilled form: upstream falls back to
           extract_default / lego_default / complete_default, i.e. "you choose". -->
      <div class="row" id="aceTrackRow" style="margin-top:8px;display:none">
        <div style="flex:1">
          <label id="aceTrackLabel">Track</label>
          <div id="aceTracks" class="acetracks"></div>
        </div>
      </div>

      <!-- 🔴 8.1-m5. Retake needs no source at all — it perturbs the noise of a song described by
           the same words — which is why it is the one mode here with needs:false. Edit DOES,
           because the flow-edit overlay reads src_audio to form zt_src/zt_tar, and text2music
           ignores src_audio otherwise.
           NOTE no backticks in this comment - one would end the template literal. -->
      <div class="row" id="aceRetakeRow" style="margin-top:8px;align-items:flex-end;display:none">
        <div style="flex:0;min-width:170px">
          <label>Seed to vary</label>
          <input type="text" id="aceRetakeSeed" placeholder="the original's seed"
                 title="The seed of the render you are taking again. The candidates tray shows each song's seed; a row action fills this in for you.">
        </div>
        <div style="flex:0;min-width:150px">
          <label>Variance <span class="muted small">— 0-1</span></label>
          <input type="number" id="aceRetakeVar" min="0" max="1" step="0.05" placeholder="0.2"
                 title="How far from the original to wander. 0 is a NO-OP upstream and re-renders the original exactly; small values keep the song and change the performance.">
        </div>
        <div style="flex:1"></div>
      </div>

      <label style="margin-top:8px">Title <span class="muted small">— what this song is called, in the picker above</span></label>
      <input type="text" id="aceTitle" placeholder="Ashes In The Rain">

      <!-- 🔴 8.1-m2b — "DESCRIBE IT AND THE LM FILLS THE CARD IN", WHICH IS NOT WHAT THE DESIGN
           ASKED FOR AND IS BETTER. Upstream's Simple mode is a RENDER mode: you describe a song,
           press Generate, and the words the model invented only ever exist inside the finished
           audio — so disliking the lyrics costs a whole render to find out. ACE-Step also exposes
           the 5Hz LM on its own, so the same feature becomes: describe it, read what it wrote,
           edit it, and render once when you actually want to.
           📌 It writes into the ordinary boxes below, so everything downstream already works:
           Save as... makes it a template, Generate renders it, the draft survives a bounce. That
           "save what Simple produced as a template" step the design calls most of the value costs
           nothing here because there is no separate place for the words to live.
           NOTE no backticks in this comment - one would end the template literal. -->
      <div class="row" style="margin-top:10px;align-items:flex-end">
        <div style="flex:1;min-width:280px">
          <label>Describe the song <span class="muted small">— and the 5Hz LM writes the caption, lyrics and musical details into the boxes below. Leave it empty for a surprise.</span></label>
          <input type="text" id="aceQuery" placeholder="a slow sad piano ballad about leaving a city at dawn" spellcheck="false">
        </div>
        <!-- ⚠️ .acesidebtns, NOT a bare flex-end group. align-items:flex-end lines the BOTTOMS up,
             which is right for two controls of the same height and wrong for a 21px button beside a
             33px input: the buttons hang off the input's bottom edge instead of sitting on its
             center line. The class pads the
             group underneath so the buttons ride the input's middle; the browser spec measures the
             two centers rather than trusting the number. -->
        <div class="acesidebtns">
          <button id="aceWrite" class="xs primary" title="Ask the 5Hz LM to write this song: caption, lyrics, BPM, key, time signature and length, straight into the boxes below.&#10;&#10;It does NOT render anything and costs no diffusion — read it, change what you like, then press Generate.&#10;&#10;⚠️ The first press after starting a backend loads the language model and can take a minute or two.">✨ Write it for me</button>
          <button id="aceTidy" class="xs" title="Rework the caption and lyrics already in the boxes below — the same pass ACE-Step calls use_format. Fills in musical details it can infer and normalizes the section markers.&#10;&#10;Nothing is rendered. If you do not like the result, the template picker still has what you saved.">✨ Tidy up</button>
        </div>
      </div>

      <label style="margin-top:8px">Caption <span class="muted small">— the style: genre, instrumentation, feel. "alternative metal, hard rock, driving drums"</span></label>
      <textarea id="aceCaption" rows="2" spellcheck="false"></textarea>

      <!-- 🔴 "SING IT LIKE" IS A NUDGE, NOT A VOICE, AND THE LABEL HAS TO SAY SO.
           AceStepTimbreEncoder is four layers on its own cross-attention path with NO
           speaker-identity objective anywhere in it: it moves vocal character toward the clip and
           it does not clone anybody. Voice Swap already applies a 15-hour-trained RVC voice in
           about thirty seconds from one button, so a control that implied it competed with that
           would be both wrong and immediately disappointing. It earns its place as a better
           STARTING vocal — something for the swap to work on — and the label promises exactly
           that much.
           ⚠️ SUPERSEDED 2026-10-11 for the Docker package: Voice Swap (and RVC) are not in it, so
           the visible label no longer sends anyone there; the paragraph above is the standalone
           edition's history and stays because the reasoning about the encoder still holds.
           NOTE no backticks in this comment - one would end the template literal.
           📌 A PICKER OVER STEMS, NOT A FILE INPUT. The encoder sees the whole mix, so a full
           song drags its arrangement in too; the useful reference is vocal-forward, which is what
           a Demucs vocals stem already is. Splitting a song is a one-click operation that already
           exists, so preparing a reference is setup rather than a step at generate time. -->
      <div class="row" style="margin-top:8px;align-items:flex-end">
        <div style="flex:1;min-width:240px;max-width:460px">
          <!-- ⚠️ FULL-STRENGTH, NOT THE GRAY EVERY FIELD LABEL USES. The accent tail was already
                there and is not the same thing: the LABEL is what users read, and gray-on-dark
                made a control that changes
               how the vocal sounds read as a footnote. Not .acemodehd — it is a field, not the
               heading of a section, so it takes the color and not the size. -->
          <label class="acefg">Sing it like <span class="hintacc small">— nudges the vocal character toward a clip. It is not voice cloning: the result sounds like a singer in that style, not like that person.</span></label>
          <select id="aceRef" title="Pick a vocal stem from your Stems library and the render leans its vocal character that way — timbre and delivery, not identity.&#10;&#10;⚠️ It also breaks Seed reproducibility: ACE-Step samples three random 10-second windows from the clip and does not seed the generator that picks them, so the same seed renders differently every time one is attached.&#10;&#10;Only sets that actually hold a vocals stem are listed."><option value="">— none —</option></select>
        </div>
        <div style="flex:1"></div>
      </div>

      <label style="margin-top:8px">Lyrics <span class="muted small">— use [verse], [chorus], [bridge] to mark sections. Leave empty and tick Instrumental for no vocals.</span></label>
      <textarea id="aceLyrics" rows="10"></textarea>

      <div class="row" style="margin-top:8px">
        <div style="flex:0;min-width:110px"><label>BPM</label>
          <input type="number" id="aceBpm" min="30" max="300" step="1" placeholder="auto"></div>
        <div style="flex:0;min-width:130px"><label>Key</label>
          <input type="text" id="aceKey" placeholder="auto" title="e.g. C Major, Am. Leave blank to let the model choose."></div>
        <div style="flex:0;min-width:120px"><label>Time sig.</label>
          <input type="text" id="aceTime" placeholder="auto" title="2 for 2/4, 3 for 3/4, 4 for 4/4, 6 for 6/8. Blank = auto."></div>
        <div style="flex:0;min-width:110px"><label>Language</label>
          <input type="text" id="aceLang" value="en" title="Vocal language code — en, zh, ja…"></div>
        <!-- ⚠️ "Length s" reads like a typo rather than a unit. An abbreviation that
             has to be decoded is worth no space at all next to four other labels that read as
             English; the track is one word wider and the field says what it wants. -->
        <div style="flex:0;min-width:150px"><label>Length <span class="muted small">— seconds</span></label>
          <input type="number" id="aceDuration" min="10" max="600" step="1" placeholder="auto"></div>
        <div style="flex:0;align-self:flex-end;padding-bottom:6px">
          <label class="chk" title="Generate with no vocals, whatever the lyrics box holds"><input type="checkbox" id="aceInstrumental"> Instrumental</label>
        </div>
        <div style="flex:1"></div>
        <!-- ⚠️ align-items is stretch, not flex-end. Aligning the bottoms lets the two buttons be
             different heights, which is what they became the moment one of them wrapped.
             Stretching makes the shorter match the taller — including when Generate forever grows
             a second line for its spinner.
             NOTE no backticks in this comment - one would end the template literal. -->
        <div style="flex:0;align-self:flex-end;display:flex;gap:8px;align-items:stretch">
          <!-- One press = one song per available card (§4.5.3). The label says the count so it
               is never a surprise how many renders a click starts; ace/cards.js knows how many
               cards there are, so it writes the number. -->
          <button id="aceGenBtn" class="go" title="Add one song per available card to the queue. Vocalis holds the queue itself and feeds each backend one song at a time, because ACE-Step cannot be asked to stop one once it starts.">▶ Generate (add to queue)</button>
          <!-- 🔴 GENERATE FOREVER. The mode runs on the SERVER, so this button reports rather
               than drives: it posts the switch and then paints whatever /acestep/jobs says, which
               is what makes it survive a page reload.
               ⚠️ The green Generate is disabled while it runs — two things queueing into a queue
               kept at depth 1 would fight, and the one that lost would look like a dead button. -->
          <button id="aceForever" class="primary" title="Keep one song waiting in the queue at all times: the moment a card frees up, another is queued. Runs on the server, so it carries on if you close this page. ⚠️ A pinned Seed in Advanced is ignored here — a fixed seed would render the same song over and over.">∞ Generate forever</button>
        </div>
`;

{
  const host = $('aceForm');
  if (host) host.innerHTML = FORM_HTML;
  // Delegated, so it covers every field without naming them one by one — a control added to
  // FORM_HTML later is persisted automatically rather than being forgotten.
  // `input` AND `change`: the first catches typing, the second catches checkboxes and selects.
  if (host) {
    const note = () => {
      saveDraft();
      paintDirty();
    };
    host.addEventListener('input', note);
    host.addEventListener('change', note);
  }
}

/** @type {AceTemplate[]} */
let TEMPLATES = [];
/** @type {string|null} */
let CURRENT = null; // the loaded template's id, or null for an unsaved song

// ── 🔴 THE DRAFT SURVIVES A BOUNCE. THIS IS THE PARADIGM, NOT A FEATURE. ──────────────────
// The draft state must survive a service restart, whether the settings are applied or still edited.
// not."*
//
// So the rule for this panel, and the one to check any new control against: ANYTHING THE USER
// PICKS OR TYPES IS REMEMBERED ACROSS A RESTART, APPLIED OR NOT. A template that has been saved
// is not the point — the point is the unsaved song in front of you, which is the most authored
// thing on the screen and was the only thing here with no home at all.
//
// ⚠️ UIS, never localStorage: it migrates every `vocalis-*` key off the client on boot and
// removes the local one, so a direct localStorage read returns null on the next load. That is
// exactly the bug the FLAC/Opus radio had.
// ⚠️ The DRAFT outranks the template on restore, because it is what was on screen. Restoring the
// saved template instead would silently discard edits — the same class of loss as the four above.
const DRAFT_KEY = 'vocalis-ace-draft';
let DRAFT_RESTORED = false;

function saveDraft() {
  try {
    UIS.setItem(DRAFT_KEY, JSON.stringify({ tpl: CURRENT, form: readForm() }));
  } catch (e) {
    /* a draft that cannot be written must never block typing */
  }
}

function restoreDraft() {
  let d = null;
  try {
    d = JSON.parse(UIS.getItem(DRAFT_KEY) || 'null');
  } catch (e) {
    d = null;
  }
  if (!d || !d.form) return false;
  CURRENT = d.tpl || null;
  fillForm(d.form);
  // 🔴 A RESTORED DRAFT IS NOT CLEAN, and `fillForm` has just marked it so. The draft is whatever
  // was on screen when the page closed — very often words typed and never saved anywhere, which
  // is the whole reason the draft exists. Leaving CLEAN set here would tell the guard below that
  // replacing them costs nothing, and clicking a library song would silently overwrite them.
  // Clearing it puts the guard back on its original test: does the form differ from its template?
  CLEAN = null;
  // 🔴 REPAINT AFTER SETTING CURRENT. paintPicker() has already run by the time this is called
  // (restore happens after it, so the <option>s exist to select) — and it is what derives the
  // ★ / Update / Delete buttons from CURRENT. Setting CURRENT without repainting left all three
  // painted for "— new song —": disabled, and `button:disabled{opacity:.45}` dimmed the gold
  // star, making the favorite state unavailable.
  // ⚠️ paintPicker also re-marks the <option>, so setting sel.value by hand here is redundant
  // AND wrong — it ran before the options were rebuilt.
  paintPicker();
  return true;
}

// 🔴 WHAT THE SONG *WAS* — Edit's other half, and it has no box on purpose (8.2.5).
// `flow_edit` integrates V_tar(the words in the form) − V_src(these), so without them Edit is an
// ordinary render wearing the wrong button — acegen says so, and the server now REFUSES an edit
// with both empty rather than rendering the lie. They are not typed, they are CARRIED: the ✏️
// Edit row action snapshots the source's caption and lyrics here, exactly as the tray tooltip
// has promised all along ("Its current caption and lyrics are carried in as what it WAS") —
// a promise nothing kept until this state existed. Rides the template like every §4.5.2 field
// (the server's _FIELDS has held both keys since m5), so a draft, a saved template and a
// library row all restore it.
let EDIT_FROM = { caption: '', lyrics: '' };

/**
 * Reads the identity fields off the form (§4.5.2) — everything a template or a Generate call
 * needs about what the song IS, never how it renders (that is readAceAdvanced, in advanced.js).
 * @returns {AceFormData}
 */
function readForm() {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [id, key] of FIELDS) {
    const el = /** @type {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} */ ($(id));
    if (!el) continue;
    out[key] =
      el.type === 'checkbox'
        ? /** @type {HTMLInputElement} */ (el).checked
        : el.type === 'number'
          ? el.value === ''
            ? null
            : Number(el.value)
          : el.value;
  }
  // 🔴 `tracks` IS NOT ONE ELEMENT, so it cannot ride the FIELDS table. It is always an ARRAY on
  // the wire — even for Extract, which uses exactly one — because the server is what knows which
  // of `track_name` and `track_classes` this mode fills in, and a client that decided would be a
  // second opinion able to drift from it.
  out.tracks = readTracks();
  out.edit_from_caption = EDIT_FROM.caption || '';
  out.edit_from_lyrics = EDIT_FROM.lyrics || '';
  // Built generically above (FIELDS is data, not a type), so the checker cannot itself prove the
  // loop covered every AceFormData key — this cast says "it did", which is exactly what the
  // three lines above and FIELDS being kept in sync are for.
  return /** @type {AceFormData} */ (out);
}

// ── 🔴 WHAT COUNTS AS "UNSAVED WORK" — a snapshot, not a template lookup ──────────────────
// `wouldLoseWork` used to ask only "does the form differ from the SELECTED TEMPLATE?", which was
// right while a template was the only thing that could ever fill this form. Clicking a library
// song fills it too, and such a song usually has no matching template (that is exactly the case
// §4.5.3 calls "— new song —") — so with the old test, loading song A and then clicking song B
// raised "⚠ Unsaved words" every single time, over words the user had never typed. A confirm that
// fires when nothing is at stake is a confirm people learn to click through, and then it is not
// protecting the case it was written for either.
//
// So: CLEAN is a snapshot taken every time the form is filled PROGRAMMATICALLY. Matching it means
// the words on screen came from somewhere they still exist, and nothing is lost by replacing
// them. Typing anything makes the form differ, and the guard is live again on the next load.
/** @type {string|null} */
let CLEAN = null;

function markClean() {
  CLEAN = JSON.stringify(readForm());
}

/** Map a saved or legacy template into the ACE-Step form fields.
 * * @param {Record<string, unknown>|null|undefined} t — a template, a `{name,caption,lyrics}`
 *   fallback (a pre-8.0-m9 library row, see the `ace:loadsong` handler below), or `null` for
 *   "new song". `undefined` reaches it too: the picker passes `TEMPLATES.find(...)`, which
 *   answers `undefined` for an id no longer in the list, and that case is the same "new song".
 *   Loosely typed because it is walked generically by FIELDS' keys below — `AceFormData` names
 *   those keys but carries no index signature, deliberately (see the note above it).
 */
function fillForm(t) {
  for (const [id, key] of FIELDS) {
    const el = /** @type {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} */ ($(id));
    if (!el) continue;
    const v = t ? t[key] : el.type === 'checkbox' ? false : '';
    if (el.type === 'checkbox') /** @type {HTMLInputElement} */ (el).checked = !!v;
    else {
      // 🔴 A <select> SILENTLY DISCARDS A VALUE IT HAS NO OPTION FOR, and the reference picker is
      // filled by a SEPARATE fetch that can easily land after this. Assigning a token whose
      // option has not arrived sets the select to "" — and because nothing remembers what was
      // asked for, the reference is then gone from the draft for good. This is the same shape as
      // the bug two comments up (paintPicker resetting the <select> under a restore); the
      // difference is that here the fix cannot be "order them", because a stem set the user has
      // since DELETED never gets an option at all and must still show as something.
      // 🔴 THE CASTS BELOW ARE THE CHECKER'S LIMIT, NOT THE RUNTIME'S: `v` really is always a
      // string at these two ids (`reference`/`source` in AceFormData), because the loop above
      // walks every FIELDS entry generically and only aceRef/aceSource ever reach this branch.
      if (id === 'aceRef') ensureRefOption(/** @type {string} */ (v));
      if (id === 'aceSource') ensureSourceOption(/** @type {string} */ (v));
      el.value = v === null || v === undefined ? '' : /** @type {string} */ (v);
    }
  }
  // The checkbox group, which is not in FIELDS for the reason readForm gives. Painted BEFORE
  // paintModeState so the boxes exist to be ticked; paintModeState then re-reads them, which is
  // what preserves the selection across a mode switch that keeps the same picker shape.
  TRACKS_WANTED = Array.isArray(t && t.tracks) ? /** @type {string[]} */ (/** @type {Record<string, unknown>} */ (t).tracks).slice() : [];
  // Edit's source words ride the template too — see EDIT_FROM above readForm.
  EDIT_FROM = {
    caption: /** @type {string} */ ((t && t.edit_from_caption) || ''),
    lyrics: /** @type {string} */ ((t && t.edit_from_lyrics) || ''),
  };
  // 🔴 THE MODE IS A FIELD, SO LOADING A TEMPLATE OR A DRAFT CHANGES IT — and the card has to
  // follow. Without this, a saved Repaint restores its mode value into a hidden input while the
  // buttons still say Write song and the source row stays hidden, i.e. a form that renders one
  // and claims another.
  paintModeState();
  markClean();
}

// ── 🔴 THE "SING IT LIKE" PICKER ──────────────────────────────────────────────────────────
// Its options come from the Stems library, which lives behind the vault — so this route is
// exactly as unreadable at boot as the template route is, and it gets the same treatment: keep
// what we had, retry, and NEVER answer "the store is shut" with "you have no clips".
/** @type {AceRef[]} */
let REFS = [];
/** @type {ReturnType<typeof setTimeout>|null} */
let REF_RETRY = null;

//: A token whose set has gone still has to render as something the user can SEE and clear.
//: Silently falling back to "— none —" would drop the reference out of a saved song with no
//: sign it had ever been there, which is the failure mode this whole control is written against.
/** @param {string} v */
function ensureRefOption(v) {
  const sel = /** @type {HTMLSelectElement} */ ($('aceRef'));
  if (!sel || !v) return;
  if ([...sel.options].some(o => o.value === v)) return;
  const known = REFS.find(r => r.token === v);
  const o = document.createElement('option');
  o.value = v;
  o.textContent = known ? known.label : `⚠ ${String(v).split(':').slice(1).join(':')} — no longer in the stems library`;
  sel.appendChild(o);
}

function paintRefs() {
  const sel = /** @type {HTMLSelectElement} */ ($('aceRef'));
  if (!sel) return;
  // Read the value BEFORE the rebuild wipes it, and put it back after — including as a "missing"
  // entry if the set it names has been deleted since the song was saved.
  const want = sel.value;
  sel.innerHTML = '<option value="">— none —</option>';
  for (const r of REFS) {
    const o = document.createElement('option');
    o.value = r.token;
    // The duration is what tells you whether a clip is long enough to sample three distinct
    // 10-second windows out of; under 30 s ACE-Step repeats it to fill, so the three windows
    // start overlapping and the reference gets narrower rather than failing.
    const secs = Number(r.duration_s || 0);
    o.textContent = secs ? `${r.label} · ${Math.round(secs)}s` : r.label;
    sel.appendChild(o);
  }
  ensureRefOption(want);
  sel.value = want;
}

// ── 🔴 8.1-m3: THE MODES ───────────────────────────────────────────────────────────────────
//
// `task` is what the card must report in `supported_task_types` for the mode to be offerable.
// `needs` marks the ones that are meaningless without source audio — the server refuses those
// rather than rendering an unrelated song, and this is the client half of the same rule.
//
// 📌 `remix-nofsq` IS A MODE HERE AND A CHECKBOX IN GRADIO, and the mechanism decided that.
// `no_fsq` appears nowhere in acestep/api, acestep/core or inference.py, so
// Gradio's checkbox of that name only selects the `cover-nofsq` task type. Modeling it as a
// payload flag would have written a field nothing reads.
//
// 🔴 THE FIRST MODE IS CALLED "WRITE SONG", NOT "CUSTOM". Upstream's word is Custom, and it means
// custom-versus-Simple — a distinction Vocalis does not have, because ✨ Write it for me writes the
// words into these same boxes instead of hiding them inside a render (see the 8.1-m2b note above).
// "Custom" named the absence of a feature next to modes named for what they do. It is the
// from-scratch mode, the only one that needs no existing song.
// ⚠️ THE ID STAYS `custom`. It is persisted in every saved draft and template and is what the
// route maps to `text2music`; renaming it would silently reset saved modes. The label is a display
// string and nothing keys off it.
const MODES = [
  {
    id: 'custom',
    label: '🎵 Write song',
    task: 'text2music',
    needs: false,
    hint:
      'Write a new song from nothing: your caption, your lyrics, your musical details. The ' +
      'only mode that works from no existing audio.\n\n' +
      'Do not want to write it yourself? ✨ Write it for me fills these boxes in.',
  },
  {
    id: 'remix',
    label: '🎛 Remix',
    task: 'cover',
    needs: true,
    hint:
      'Restyle a song you already have. Keep original decides how much of it survives.\n\n' +
      'The 5Hz planner is skipped for this task, so BPM, key, time signature and length are ' +
      'taken from the source rather than from the boxes below.',
  },
  {
    id: 'remix-nofsq',
    label: '🎛 Remix (no FSQ)',
    task: 'cover-nofsq',
    needs: true,
    // 🔴 THIS TOOLTIP USED TO SAY "the same operation without the FSQ stage", WHICH IS THE LABEL
    // AGAIN. It described how UPSTREAM models
    // the option (a Gradio checkbox versus a task type), which is a fact about someone else's code
    // and cannot help anyone choose. In ACE-Step 1.5, conditioning_masks.py:70 sets
    // `is_cover = (task_type == "cover")`, and its tests
    // name the consequence: "Standard cover mode should trigger cover-token roundtrip
    // conditioning" against "Raw cover mode should keep VAE latents instead of FSQ roundtrip
    // latents". So plain Remix reads the source through a quantizer; this one reads it directly.
    hint:
      'Remix, but the model reads your source at full detail.\n\n' +
      'Plain Remix first pushes the audio through FSQ — a compression stage that rounds it into ' +
      'a coarse grid of fixed values — and works from that summary. This mode skips it, so the ' +
      'fine texture and timing of the original survive into the result instead of being ' +
      'averaged away.\n\n' +
      'Reach for it when a Remix comes back over-smoothed, or mushy where the original was crisp.',
  },
  {
    id: 'extract',
    label: '🎚 Extract',
    task: 'extract',
    needs: true,
    tracks: 'one',
    hint:
      'Pull ONE track out of a song — the vocal, the drums, whatever you pick.\n\n' +
      'Leave the picker empty and the model chooses which track to isolate.',
  },
  {
    id: 'lego',
    label: '🧩 Replace',
    task: 'lego',
    needs: true,
    tracks: 'one',
    hint:
      'Regenerate ONE track and keep the rest of the arrangement — a new bassline under the ' +
      'same song.\n\nUnlike Extract and Remix, this one DOES use the 5Hz planner.',
  },
  {
    id: 'complete',
    label: '➕ Complete',
    task: 'complete',
    needs: true,
    tracks: 'many',
    hint:
      'Fill in tracks that are missing from a partial mix. Tick every one you want added.\n\n' +
      'Leave them all unticked and the model decides what the song is short of.',
  },
  {
    id: 'retake',
    label: '🎲 Retake',
    task: 'text2music',
    needs: false,
    retake: true,
    hint:
      'Another take of the SAME song — the original seed, nudged, rather than a fresh one.' +
      '\n\n⚠️ Variance 0 is a no-op upstream: the seed is only used above zero, so a Retake ' +
      'at zero silently renders the original again. Small numbers wander, large ones leave.',
  },
  {
    id: 'edit',
    label: '✏️ Edit',
    task: 'text2music',
    needs: true,
    edit: true,
    hint:
      'Morph a song toward NEW words. It integrates the difference between what you write ' +
      'above and what the song used to say, so it changes what you changed and leaves the ' +
      'rest.\n\n🔴 Needs the source AND the words it had — with those blank the difference ' +
      'is the whole target and this is just an ordinary render.\n\n📌 The 5Hz planner is ' +
      'skipped for this, like Remix and Repaint.',
  },
  {
    id: 'repaint',
    label: '🩹 Repaint',
    task: 'repaint',
    needs: true,
    hint:
      'Regenerate ONE time range and leave the rest of the song exactly as it was.\n\n' +
      '⚠️ From and To alone will sound dropped in. Repaint mode, Repaint strength and the two ' +
      'crossfades in ⚙ Advanced are what make the new section join the old one.',
  },
];

//: Which task types the LIVE cards can actually run — the union across them, because a job goes
//: to whichever card frees up first and any of them may take it.
let CARD_TASKS = new Set();
/** @type {string[]} */
let CARD_NAMES = [];
//: task -> the models ON DISK (any card's menu) that can run it, and task -> the models the publisher
//: lists for it. Both come from the server's `tasks` / `task_models` (the publisher table in
//: `acegen.PUBLISHED_TASKS`), and they only feed the sentence a disabled mode button shows.
/** @type {Record<string, string[]>} */
let DISK_FOR_TASK = {};
/** @type {Record<string, string[]>} */
let PUBLISHED_FOR_TASK = {};

//: The one sentence a disabled mode button shows (October 11, 2026): which model to load. Extract,
//: Replace and Complete run only on acestep-v15-xl-base; xl-sft and turbo cannot.
/** @param {{label: string, task: string}} m */
function whichModelSentence(m) {
  const name = m.label.replace(/^[^A-Za-z]+/, '');
  const have = DISK_FOR_TASK[m.task] || [];
  if (have.length) return `${name} needs the ${have.join(' or ')} model. Load it from this card's model menu.`;
  const want = PUBLISHED_FOR_TASK[m.task] || [];
  if (want.length) {
    return `${name} needs the ${want.join(' or ')} model, which is not on this computer. ` + 'Run setup again to download it.';
  }
  return `${name} needs a model that supports "${m.task}", and none is installed.`;
}

/** @param {string} id */
function modeDef(id) {
  return MODES.find(m => m.id === id) || MODES[0];
}

function currentMode() {
  return modeDef(/** @type {HTMLInputElement} */ ($('aceMode'))?.value || 'custom');
}

function paintModes() {
  const host = $('aceModes');
  if (!host) return;
  const cur = /** @type {HTMLInputElement} */ ($('aceMode'))?.value || 'custom';
  host.innerHTML = '';
  for (const m of MODES) {
    // 🔴 UNSUPPORTED IS DISABLED WITH A REASON, NOT HIDDEN. A mode that vanishes because of which
    // model a card happens to hold is indistinguishable from a mode this build never had — and
    // the fix (load the other model) is exactly the thing the tooltip can say and absence cannot.
    // ⚠️ An EMPTY task set means "we have not been told yet", not "nothing is supported": at boot,
    // and on a box whose backends are down, everything stays enabled rather than the card
    // collapsing to one mode with a tooltip blaming a model nobody has loaded.
    const known = CARD_TASKS.size > 0;
    const ok = !known || CARD_TASKS.has(m.task);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'xs acemode' + (m.id === cur ? ' on' : '');
    b.textContent = m.label;
    b.disabled = !ok;
    // October 11, 2026: the sentence names the model to load (it used to say only that the loaded one
    // cannot run the mode). Which models are loaded is in CARD_NAMES and still shapes `ok` above.
    b.title = ok ? m.hint : whichModelSentence(m);
    b.addEventListener('click', () => setMode(m.id));
    host.appendChild(b);
  }
}

//: The metadata the model takes from the SOURCE instead of from the form, per mode (design §3).
//: Dimmed rather than hidden so the card does not reflow and the value stays readable.
/** @type {Record<string, string[]>} */
const INERT_BY_MODE = {
  remix: ['aceBpm', 'aceKey', 'aceTime', 'aceDuration'],
  'remix-nofsq': ['aceBpm', 'aceKey', 'aceTime', 'aceDuration'],
  repaint: ['aceBpm', 'aceKey', 'aceTime', 'aceDuration'],
  // Extract is an isolation, not a composition: caption, lyrics and every musical detail come
  // from the source, so the whole metadata row goes inert. Complete and Lego still write music,
  // so they keep the caption and only lose Length, which the source decides.
  extract: ['aceBpm', 'aceKey', 'aceTime', 'aceDuration'],
  lego: ['aceDuration'],
  complete: ['aceDuration'],
};

//: `constants.py:152`, verbatim and in upstream's own order — grouped by instrument family
//: rather than alphabetically, which is how a musician scans it.
const TRACK_NAMES = [
  'woodwinds',
  'brass',
  'fx',
  'synth',
  'strings',
  'percussion',
  'keyboard',
  'guitar',
  'bass',
  'drums',
  'backing_vocals',
  'vocals',
];

//: What a restore ASKED FOR, which is not always what is on screen: `fillForm` runs before the
//: boxes for this mode have been painted, so the wanted set is held here and applied by the next
//: `paintTracks`. Same shape as `ensureRefOption` — a value must never be lost just because the
//: control that would hold it does not exist yet.
/** @type {string[]} */
let TRACKS_WANTED = [];

function readTracks() {
  const host = $('aceTracks');
  if (!host || !host.children.length) return TRACKS_WANTED.slice();
  return [...host.querySelectorAll('input:checked')].map(el => /** @type {HTMLInputElement} */ (el).value);
}

function paintTracks() {
  const host = $('aceTracks');
  if (!host) return;
  const m = currentMode();
  const one = m.tracks === 'one';
  const chosen = new Set(readTracks());
  TRACKS_WANTED = [];
  host.innerHTML = '';
  for (const name of TRACK_NAMES) {
    const lab = document.createElement('label');
    lab.className = 'chk acetrack';
    const box = document.createElement('input');
    // 🔴 RADIO FOR EXTRACT AND LEGO, CHECKBOX FOR COMPLETE, and the difference is upstream's
    // rather than a style choice: `track_name` is ONE name that gets `.upper()` called on it,
    // `track_classes` is a LIST that gets joined. A multi-select feeding a singular field would
    // send a list into `.upper()`.
    box.type = one ? 'radio' : 'checkbox';
    box.name = 'acetrack';
    box.value = name;
    box.checked = chosen.has(name);
    lab.appendChild(box);
    lab.appendChild(document.createTextNode(' ' + name.replace('_', ' ')));
    host.appendChild(lab);
  }
}

function paintModeState() {
  const m = currentMode();
  const row = $('aceSourceRow');
  if (row) row.style.display = m.needs ? '' : 'none';
  const trow = $('aceTrackRow');
  if (trow) trow.style.display = m.tracks ? '' : 'none';
  const rrow = $('aceRetakeRow');
  if (rrow) rrow.style.display = m.retake ? '' : 'none';
  if (m.tracks) paintTracks();
  const tlab = $('aceTrackLabel');
  if (tlab) {
    tlab.textContent =
      m.tracks === 'one'
        ? 'Track — which ONE. Leave it unpicked and the model chooses.'
        : 'Tracks to add — tick every one. Leave them all off and the model decides what is missing.';
  }
  // Cover strength belongs to the remix family; the range belongs to repaint. Same row, because
  // they are the same question — "which part of the source am I keeping" — asked two ways.
  const isRepaint = m.id === 'repaint';
  // The tuple annotation is what keeps `id` a string: inferred, this literal is
  // `(string|boolean)[][]` and `$(id)` stops type-checking. Same shape as ace/advanced.js's KNOBS.
  for (const [id, on] of /** @type {ReadonlyArray<readonly [id: string, on: boolean]>} */ ([
    ['aceCoverWrap', !isRepaint],
    ['aceRepaintFrom', isRepaint],
    ['aceRepaintTo', isRepaint],
  ])) {
    const el = $(id);
    if (el) el.style.display = on ? '' : 'none';
  }
  const inert = new Set(INERT_BY_MODE[m.id] || []);
  const INERT_TITLE = 'Taken from the source song in this mode — the 5Hz planner is skipped for it.';
  for (const id of ['aceBpm', 'aceKey', 'aceTime', 'aceDuration']) {
    const el = /** @type {HTMLInputElement} */ ($(id));
    if (!el) continue;
    // 🔴 STASH BEFORE THE FIRST OVERWRITE, or the restore below restores nothing. This wrote the
    // inert title over `el.title` and read `el.dataset.title` back — which nothing had ever set,
    // so one visit to Remix ate the real tooltips ("e.g. C Major, Am…") permanently, and the
    // re-enabled boxes went on claiming their value came from a source that no longer applied.
    // Guarded against stashing the inert sentence itself, for the page that boots straight into
    // a restored inert-mode draft.
    if (!el.dataset.title && el.title && el.title !== INERT_TITLE) el.dataset.title = el.title;
    el.disabled = inert.has(id);
    // A dimmed box still SAYS what it would have been, which is the whole reason this dims
    // rather than clears — and why the title explains the reason rather than just going gray.
    el.style.opacity = inert.has(id) ? '0.45' : '';
    el.title = inert.has(id) ? INERT_TITLE : el.dataset.title || el.title || '';
  }
  paintModes();
}

/** @param {string} id */
function setMode(id) {
  const el = /** @type {HTMLInputElement} */ ($('aceMode'));
  if (!el) return;
  el.value = id;
  paintModeState();
  saveDraft();
  paintDirty();
  noteForeverEdit();
}

// 🔴 PAINT THE MODES ONCE AT LOAD, AND THIS LINE IS A BUG FIX RATHER THAN TIDINESS.
//
// `paintModeState` was reached only from `fillForm` and `setMode` — i.e. only when a draft or a
// template filled the form, or when a mode button was pressed. On a FRESH page with no saved
// draft, `restoreDraft` returns early, `fillForm` never runs, and `#aceModes` was therefore never
// populated: **the mode selector did not exist at all for a new user.** Every mode this release
// added was unreachable, with no error anywhere — the exact `?.addEventListener` shape this tab
// keeps getting caught by, and every unit and route spec was green over it.
//
// Found by the browser spec pressing the Remix button and getting `undefined.click()`, which is
// why that spec exists: it asserts consequences, and a control that was never painted has none.
//
// ⚠️ IT MUST BE HERE, NOT IN THE MODULE-INIT BLOCK AT THE TOP. That block runs before
// `CARD_TASKS` and `MODES` are evaluated, and reaching a `let` from its temporal dead zone throws
// a ReferenceError that would take the whole module down.
paintModeState();

/** @type {AceSource[]} */
let SOURCES = [];
/** @type {ReturnType<typeof setTimeout>|null} */
let SOURCE_RETRY = null;

// 🔴 THE OPTION TEXT IS TITLE PLUS SEED, and the seed distinguishes rows with otherwise identical
// titles. Retake and ∞ Generate
// forever both produce exactly that, so "Library ▸ Ashes In The Rain" three times over was the
// normal state of this dropdown and picking the right one was a coin flip.
// ⚠️ Composed HERE rather than on the server, because `label` has two other jobs: the "⚠ … no
// longer available" line, and the title the row action writes into the form. A seed baked into it
// would end up inside a song's NAME.
/** @param {AceSource|null|undefined} s */
function srcText(s) {
  return `${(s && s.label) || 'Untitled'}${fmtSeed(s && s.seed, ' — ')}`;
}

/** @param {string} v */
function ensureSourceOption(v) {
  const sel = /** @type {HTMLSelectElement} */ ($('aceSource'));
  if (!sel || !v) return;
  if ([...sel.options].some(o => o.value === v)) return;
  const known = SOURCES.find(s => s.token === v);
  const o = document.createElement('option');
  o.value = v;
  // ⚠️ SAME REASON AS THE REFERENCE PICKER, AND IT BITES HARDER HERE. A <select> silently drops a
  // value it has no option for, and a source can legitimately disappear — a candidate does not
  // survive its backend restarting, by design. Losing it silently would leave a Remix pointing at
  // nothing, which the server then refuses with a message about a source the form no longer shows.
  o.textContent = known ? srcText(known) : `⚠ ${String(v).split(':').slice(1).join(':')} — no longer available`;
  sel.appendChild(o);
}

function paintSources() {
  const sel = /** @type {HTMLSelectElement} */ ($('aceSource'));
  if (!sel) return;
  const want = sel.value;
  sel.innerHTML = '<option value="">— pick a song —</option>';
  let group = null;
  for (const s of SOURCES) {
    if (s.group !== group) {
      group = s.group;
      const g = document.createElement('optgroup');
      g.label = /** @type {string} */ (group);
      sel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = s.token;
    o.textContent = srcText(s);
    const last = /** @type {Element} */ (sel.lastChild);
    (last.tagName === 'OPTGROUP' ? last : sel).appendChild(o);
  }
  ensureSourceOption(want);
  sel.value = want;
}

export async function loadAceSources() {
  let got = null;
  // ⚠️ `locked` IS THE "STORE IS SHUT" FLAG, and it takes the same path as a transport failure:
  // keep what we have and retry. The route deliberately answers a locked vault with an empty
  // list and this flag — without checking it, a boot that landed in the locked window painted a
  // saved source as "⚠ … no longer available" over a store that merely was not open yet.
  try {
    const r = await jget('/acestep/sources');
    got = r && r.locked ? null : r.sources;
  } catch (e) {
    got = null;
  }
  if (!Array.isArray(got)) {
    clearTimeout(SOURCE_RETRY ?? undefined);
    SOURCE_RETRY = setTimeout(loadAceSources, 4000);
    return;
  }
  SOURCES = got;
  paintSources();
}

// ── 🔴 8.1-m3 §7: THE ROW ACTION IS THE PRIMARY ENTRY POINT INTO A MODE ────────────────────
//
// Every upstream mode opens with "upload source audio", because Gradio has nowhere else to get
// audio from. Vocalis has a candidates tray and a library, so the source is almost always
// something the user is already looking at — which makes the row action the natural way in and
// the mode selector the fallback for when you know what you want before hearing anything.
//
// Selecting one does four things (design §7): switch the mode, set the source, carry the existing
// words forward EDITABLE, and put the card in front of the user.
//
// ⚠️ THE WORDS ARE CARRIED, NOT REPLACED, AND ONLY WHEN THERE IS NOTHING TO LOSE. A remix of a
// song usually wants that song's caption and lyrics as its starting point — but if the form
// already holds unsaved words, silently overwriting them is the data loss `wouldLoseWork` exists
// to prevent. So: fill the empty form, and leave a written-in one alone.
/**
 * `words` is nullable as well as optional: the tray's candidate arm passes `j.rendered || null`
 * for a row that has no rendered words, and every read of it below is already guarded.
 * @param {{token: string, mode: string, label?: string,
 *           words?: {caption?: string, lyrics?: string}|null, seed?: number|string|null}} p
 */
export function prefillFromSource({ token, mode, label, words, seed }) {
  const sel = /** @type {HTMLSelectElement} */ ($('aceSource'));
  if (!sel) return;
  ensureSourceOption(token);
  sel.value = token;
  const f = readForm();
  const empty = !(f.caption || '').trim() && !(f.lyrics || '').trim();
  if (empty && words) {
    // The tuple annotation keeps `key` a literal `'caption'|'lyrics'` rather than a bare `string`
    // — same shape as paintModeState's below, and needed for the same reason: `words` has no
    // index signature (see the typedef above), and a widened `key` cannot index it.
    for (const [key, id] of /** @type {ReadonlyArray<readonly [key: 'caption'|'lyrics', id: string]>} */ ([
      ['caption', 'aceCaption'],
      ['lyrics', 'aceLyrics'],
    ])) {
      const el = /** @type {HTMLTextAreaElement} */ ($(id));
      if (el && words[key]) el.value = words[key];
    }
    // A title makes the candidates tray legible once two remixes of the same song are queued.
    const t = /** @type {HTMLInputElement} */ ($('aceTitle'));
    if (t && !t.value.trim() && label) t.value = `${label} (${mode})`;
  }
  // 🔴 EDIT'S "WHAT IT WAS" IS SET UNCONDITIONALLY, unlike the carry above. The editable copy
  // respects unsaved work; the SOURCE snapshot is a fact about the song being pointed at, not
  // authored work, and an Edit whose source words are missing is refused by the server — so the
  // row action must never skip them just because the form already held words.
  if (mode === 'edit') {
    EDIT_FROM = { caption: (words && words.caption) || '', lyrics: (words && words.lyrics) || '' };
  }
  // 🎲 The seed the tooltip promises ("a row action fills this in for you") — nothing filled it
  // until now, so every UI Retake sent a blank seed, which upstream reads as "no retake": a
  // fresh-seed song wearing the Retake label. Only for retake; other modes ignore the box.
  if (mode === 'retake' && seed !== undefined && seed !== null && String(seed) !== '') {
    const rs = /** @type {HTMLInputElement} */ ($('aceRetakeSeed'));
    if (rs) rs.value = String(seed);
  }
  setMode(mode);
  // 🔴 CLEAN IS CLEARED, because what is on screen now differs from any template it came from —
  // and this is exactly the case the ⚠ Unsaved words guard is for. `setMode` already saved the
  // draft; this is the other half of "the form is authored work now".
  CLEAN = null;
  saveDraft();
  paintDirty();
  // The card is above the tray, so a press down there can leave the source controls off screen.
  $('aceSourceRow')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

//: Guard for the repaint below: the event fires on every 4 s status tick, and `paintModes`
//: rebuilds `#aceModes` wholesale — destroying an open tooltip, keyboard focus on a mode
//: button, and any click straddling the swap. Repainting only when the ANSWER changed makes
//: the steady state free; a model load or unload still repaints within one tick.
/** @type {string|null} */
let TASKS_SIG = null;

//: What the cards can run. Called on tab entry with the models the rows already fetched, so this
//: costs no extra request — `ace/cards.js` owns that poll and hands the answer over.
//:
//: 🔴 GATED ON THE MODELS THE CARDS ACTUALLY *HOLD*, NOT ON THE INVENTORY (8.2.5). The first cut
//: unioned `info.tasks` over every model ON DISK — and xl-sft sat in every inventory supporting
//: all seven task types, so the union was always everything and the gate never engaged: with two
//: turbos loaded, Extract stayed pressable and the press burned a render. (October 11, 2026: the
//: server now narrows the engine's list to the publisher's, so xl-sft reports four task types and
//: only xl-base reports all seven; the loaded-models rule below is still the right one.) `loadedModels` is the
//: set the status poll reports loaded; empty (nothing loaded anywhere) falls back to the
//: "not been told yet" permissive state, same as boot — generating then fails loudly on
//: "Model not fully initialized", which is the honest error for that state.
/**
 * @param {Record<string, {tasks?: Record<string, string[]>, task_models?: Record<string, string[]>}>|null|undefined} byDevice — one
 *   entry per live card, as `ace:cardmodels`' detail carries it.
 * @param {string[]|null|undefined} loadedModels
 */
export function noteAceTasks(byDevice, loadedModels) {
  const tasks = new Set();
  const names = new Set();
  const loaded = new Set(loadedModels || []);
  /** @type {Record<string, Set<string>>} */
  const disk = {};
  /** @type {Record<string, string[]>} */
  const published = {};
  for (const info of Object.values(byDevice || {})) {
    for (const [model, list] of Object.entries((info && info.tasks) || {})) {
      for (const t of list || []) (disk[t] = disk[t] || new Set()).add(model);
      if (!loaded.has(model)) continue;
      names.add(model);
      for (const t of list || []) tasks.add(t);
    }
    for (const [t, models] of Object.entries((info && info.task_models) || {})) published[t] = models || [];
  }
  CARD_TASKS = tasks;
  CARD_NAMES = [...names];
  DISK_FOR_TASK = Object.fromEntries(Object.entries(disk).map(([t, s]) => [t, [...s].sort()]));
  PUBLISHED_FOR_TASK = published;
  const sig =
    [...tasks].sort().join(',') +
    '|' +
    [...names].sort().join(',') +
    '|' +
    JSON.stringify(DISK_FOR_TASK) +
    JSON.stringify(PUBLISHED_FOR_TASK);
  if (sig === TASKS_SIG) return;
  TASKS_SIG = sig;
  paintModes();
}

// The card rows already poll `/acestep/status` and fetch `/acestep/models`; this rides the event
// they already dispatch rather than opening a second timer over the same routes — one poll, one
// idea of what each card is holding. Without this line `noteAceTasks` is dead code and the mode
// gating silently never engages.
document.addEventListener('ace:cardmodels', ev => {
  noteAceTasks((ev.detail && ev.detail.byDevice) || {}, (ev.detail && ev.detail.models) || []);
});

export async function loadAceRefs() {
  let got = null;
  // Same `locked` handling as loadAceSources, same reason: a shut store is not an empty one.
  try {
    const r = await jget('/acestep/references');
    got = r && r.locked ? null : r.references;
  } catch (e) {
    got = null;
  }
  if (!Array.isArray(got)) {
    clearTimeout(REF_RETRY ?? undefined);
    REF_RETRY = setTimeout(loadAceRefs, 4000);
    return;
  }
  REFS = got;
  paintRefs();
}

// Favorites first, then by name. The client sorts because the store has no opinion about it and
// a server-side order would need a second round trip to change.
/** @param {AceTemplate[]} items */
function sortTemplates(items) {
  // ⚠️ `Number(...)` MAKES EXPLICIT WHAT THE COMPARISON ALREADY DID AT RUNTIME. `favorite` is a
  // real boolean once typed, and `boolean - boolean` is not a legal TS arithmetic operand even
  // though JS has always coerced true/false to 1/0 here — same result (including `NaN` when both
  // are `undefined`, exactly as `undefined - undefined` was), spelled out for the checker.
  return [...items].sort((a, b) => Number(b.favorite) - Number(a.favorite) || String(a.name).localeCompare(String(b.name)));
}

function paintPicker() {
  const sel = $('aceTemplate');
  if (!sel) return;
  // 🔴 AN EMOJI STAR IN THE PICKER, A GLYPH STAR ON THE BUTTON, AND THAT IS DELIBERATE.
  // The button is a real element and CSS paints it (`#aceTplStar.starred`). An <option> is not:
  // it takes no child markup, so there is nothing to put a class on, and coloring the option
  // itself would turn the song's NAME gold too — which says "this whole row is special" rather
  // than "this one is a favorite". U+2B50 is gold in the font itself, so it needs no CSS and is
  // gold in the closed select as well as the open list, on every platform.
  const opts = ['<option value="">— new song —</option>'].concat(
    sortTemplates(TEMPLATES).map(
      t => `<option value="${esc(t.id)}"${t.id === CURRENT ? ' selected' : ''}>` + `${t.favorite ? '⭐ ' : ''}${esc(t.name)}</option>`,
    ),
  );
  sel.innerHTML = opts.join('');
  const star = /** @type {HTMLButtonElement} */ ($('aceTplStar'));
  if (star) {
    const t = TEMPLATES.find(x => x.id === CURRENT);
    // ⚠️ A FILLED STAR THAT IS NOT GOLD READS AS DISABLED, not as "on". The glyph alone carried
    // the state while its color contradicted it.
    star.textContent = t && t.favorite ? '★' : '☆';
    star.classList.toggle('starred', !!(t && t.favorite));
    star.disabled = !t;
  }
  // Both act on the SELECTED template, so both are dead without one — the same disabled-state
  // rule the Create-a-voice picker uses, and what keeps "Save" from ever meaning "Save as".
  for (const id of ['aceTplUpdate', 'aceTplDel']) {
    const b = /** @type {HTMLButtonElement} */ ($(id));
    if (b) b.disabled = !CURRENT;
  }
  paintDirty();
}

// 🔴 IS WHAT IS ON SCREEN SAVED ANYWHERE? Two different "no", and they want different words.
//
// With a template loaded, the question is whether the form still matches it — the same comparison
// the picker uses to decide whether a library song still belongs to its template, so it is
// `fieldsAgree` rather than a second opinion about what "changed" means.
//
// With no template, nothing can be "modified"; the honest thing to say is that this song has no
// home yet, which is what "Save as…" is for. Saying nothing there would be worse: an unsaved song
// with hours of lyrics in it looks exactly like a saved one.
//
// ⚠️ THE ADVANCED KNOBS ARE DELIBERATELY NOT PART OF THIS. §4.5.2 keeps them off templates
// entirely — a template is draftable on turbo and renderable on xl-sft — so "your Steps differ
// from the template's" is a sentence about something that does not exist, and an indicator that
// lit up for it could never be cleared by saving.
function paintDirty() {
  const el = $('aceTplDirty');
  if (!el) return;
  const f = readForm();
  const t = TEMPLATES.find(x => x.id === CURRENT);
  const words = !!(String(f.lyrics || '').trim() || String(f.caption || '').trim() || String(f.name || '').trim());
  // ⚠️ AND IT SAYS NOTHING WHILE THE LIST IS STILL UNKNOWN. During the moment after a restart when
  // the vault is locked, TEMPLATES is empty because it could not be READ — so a song that has a
  // template would be labeled "not saved to a template", which is the loudest possible way to be
  // wrong about someone's work. Silence until the retry above succeeds, then the truth.
  // 🔴 ONE ANSWER, TWO CONTROLS. The dirty pill and ↩ Revert changes are the same fact seen
  // twice — "the boxes differ from the template you have open" — so they are computed once here.
  // Two separate tests of it is how a Revert button ends up offered with nothing to revert to, or
  // withheld while the pill says there are changes.
  const drifted = (TEMPLATES_LOADED || !CURRENT) && !!t && !fieldsAgree(f, t);
  const msg = !TEMPLATES_LOADED && CURRENT ? '' : t ? (drifted ? '● unsaved changes' : '') : words ? '● not saved to a template' : '';
  // ⚠️ NOT MERELY "IS THE FORM DIRTY". With no template selected there is no earlier state to
  // go back TO, and a button that cleared the form instead would be a different verb wearing this
  // one's name — so an unsaved brand-new song shows the pill and no Revert.
  const rev = $('aceTplRevert');
  if (rev) rev.style.display = drifted ? '' : 'none';
  el.textContent = msg;
  el.title = t
    ? 'The boxes below differ from the template selected on the left. 💾 Save writes them back into it; 💾 Save as… keeps that one and makes a new template.'
    : 'This song is not stored under any template — 💾 Save as… gives it a name and puts it in the picker.';
  el.style.display = msg ? '' : 'none';
}

//: 🔴 HAS THE LIST ACTUALLY BEEN READ? Not the same question as "is it empty".
let TEMPLATES_LOADED = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let TEMPLATE_RETRY = null;

export async function loadAceTemplates() {
  // 🔴 A FAILED READ MUST NOT BECOME "YOU HAVE NO TEMPLATES", AND IT USED TO.
  // This was `catch (e) { TEMPLATES = []; }`, which threw away the one distinction the store
  // takes eight lines to preserve — `acetemplates._read` refuses to catch the locked-vault error
  // precisely so that "the vault is shut" is never answered with "you have no songs". The client
  // then answered it that way anyway.
  //
  // It matters most at exactly the wrong moment: the vault is locked for a moment after the
  // service restarts, so the tab's ONE call to this route lands in that window, gets a 500, and
  // shows an empty picker forever. The draft restores the words but its template id matches
  // nothing, so the picker reads "— new song —" and the marker says "not saved to a template"
  // over a song that is saved.
  //
  // ⚠️ So: keep whatever we had, and RETRY. Nothing else in the tab will trigger a reload on its
  // own, which is why one failure was permanent rather than transient.
  let ok = true;
  try {
    TEMPLATES = (await jget('/acestep/templates')).templates || [];
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    paintPicker();
    clearTimeout(TEMPLATE_RETRY ?? undefined);
    TEMPLATE_RETRY = setTimeout(loadAceTemplates, 2000);
    return;
  }
  TEMPLATES_LOADED = true;
  paintPicker();
  // 🔴 AFTER paintPicker, and ONCE. The picker rebuilds its <option>s, which resets the <select>
  // to its first entry — so restoring before this would be undone by the very next line, in the
  // same shape as the card dropdown reverting to turbo on every 4 s repaint. And once, because
  // loadAceTemplates is called again after every save/rename/delete: re-restoring there would
  // throw away whatever had been typed since.
  if (!DRAFT_RESTORED) {
    DRAFT_RESTORED = true;
    restoreDraft();
  }
}

// ⚠️ LOADING A TEMPLATE OVERWRITES WHAT IS IN THE FORM, so it asks first when the form holds
// unsaved words. Not for every change — only when there are LYRICS or a CAPTION to lose, because
// a confirm on an empty form is the kind of ceremony that trains people to click through them.
async function wouldLoseWork() {
  const f = readForm();
  if (!(f.lyrics || '').trim() && !(f.caption || '').trim()) return false;
  if (CLEAN !== null && JSON.stringify(f) === CLEAN) return false; // came from a template or a song
  const saved = TEMPLATES.find(t => t.id === CURRENT);
  if (saved && saved.lyrics === f.lyrics && saved.caption === f.caption) return false;
  return !(await modal(
    '⚠ Unsaved words',
    'The form has lyrics or a caption that are not saved to a template. Loading another one ' + 'replaces them. Continue?',
    [
      { label: 'Cancel', value: 0 },
      { label: 'Discard and load', class: 'danger', value: 1 },
    ],
  ));
}

$('aceTemplate')?.addEventListener('change', async ev => {
  const id = /** @type {HTMLSelectElement} */ (ev.target).value;
  if (await wouldLoseWork()) {
    paintPicker();
    return;
  } // repaint puts the picker back
  CURRENT = id || null;
  fillForm(id ? TEMPLATES.find(t => t.id === id) : null);
  paintPicker();
  // 🔴 SAVED HERE, EXPLICITLY, AND NOT LEFT TO THE DELEGATED LISTENER. This handler is `async`:
  // it awaits `wouldLoseWork()` before it touches CURRENT, while the form host's delegated
  // `change` listener runs on the SAME event, on bubble, straight away — so the draft was being
  // written with the PREVIOUS template id and the picker came back as "— new song —" on reload.
  // ⚠️ An await between reading a control and persisting it is always this bug. Persist after
  // the state settles, in the handler that owns it.
  saveDraft();
  // 🔴 The library below filters to this template by default (§4.5.3) — the songs made FROM it.
  document.dispatchEvent(new CustomEvent('ace:template', { detail: { id: CURRENT } }));
});

// 🔴 TWO BUTTONS, NOT ONE THAT GUESSES — matching Create-a-voice's picker exactly (7.0-m7).
// "Save" writes back into the template you opened; "Save as…" always makes a new one. A single
// button that decided for itself would eventually overwrite twenty minutes of lyrics on a
// template someone merely had selected, and the user's only clue would have been which row was
// highlighted. Save is DISABLED with nothing loaded, so the two can never be confused.
// ⚠️ A SILENT SUCCESS IS INDISTINGUISHABLE FROM A DEAD BUTTON. Saving a template repainted the
// picker with no visible acknowledgment, so the save button briefly reports success.
//
// 🔴 THE ORIGINAL LABEL IS CAPTURED ONCE, NOT ON EVERY PRESS. Press Save twice inside the window
// and a naive version reads "✓ Saved" back out of the button and restores THAT — leaving the
// control permanently claiming a save it is no longer reporting. The timer is cleared and the
// stored label kept instead.
// 📌 `button.ok` is the existing green in controls.css, so this is the same green as every other
// affirmative control on the page rather than a new literal that only works on one skin.
/**
 * The two elements that carry a flash-back timer and their pre-flash label ON THE ELEMENT
 * ITSELF, the same expando-on-the-node convention `types/vocalis.d.ts` declares for `_audRunning`
 * and friends — not declared there because these two names exist only on the handful of buttons
 * in this one file. The base is `HTMLButtonElement` because both call sites hand it the
 * `currentTarget` of a click bound to `#aceTplUpdate` / `#aceTplSave`, and those are `<button>`s
 * (see FORM_HTML) — it used to say `EventTarget`, which only type-checked while a since-deleted
 * global declaration pretended every `EventTarget` had `.textContent` and `.classList`.
 * `__flashLabel` is nullable because it is filled from `.textContent`, which is `string|null`.
 * @typedef {(HTMLButtonElement & {__flashTimer?: ReturnType<typeof setTimeout>|null,
 *                                 __flashLabel?: string|null})|null|undefined} FlashTarget
 */

/** @param {FlashTarget} btn */
function flashSaved(btn) {
  if (!btn) return;
  if (btn.__flashTimer) clearTimeout(btn.__flashTimer);
  else btn.__flashLabel = btn.textContent;
  btn.textContent = '✓ Saved';
  btn.classList.add('ok');
  btn.__flashTimer = setTimeout(() => {
    // Set on the first press by the `else` above and never cleared, so it is always a string here.
    btn.textContent = /** @type {string|null} */ (btn.__flashLabel);
    btn.classList.remove('ok');
    btn.__flashTimer = null;
  }, 2500);
}

/**
 * @param {boolean} asNew
 * @param {FlashTarget} btn
 */
async function saveTemplate(asNew, btn) {
  const f = readForm();
  const name = String(f.name || '').trim();
  if (!name) {
    await modal('This song needs a title', 'Give it a title so you can find it in the picker later.', [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  try {
    const saved =
      !asNew && CURRENT ? await jpost('/acestep/templates/' + encodeURIComponent(CURRENT), f) : await jpost('/acestep/templates', f);
    CURRENT = saved.id;
    await loadAceTemplates();
    // 🔴 AFTER loadAceTemplates, not before. It repaints the picker, and paintPicker sets
    // `disabled` on these buttons — flashing first would be correct anyway, but the ordering
    // makes it obvious that nothing between here and the user's eye can undo it.
    flashSaved(btn);
    // The form now matches what is stored, so replacing it later loses nothing.
    markClean();
  } catch (e) {
    await modal('Could not save the template', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  }
}

$('aceTplUpdate')?.addEventListener('click', ev => saveTemplate(false, /** @type {FlashTarget} */ (ev.currentTarget)));

// ↩ Revert changes — re-apply the open template and throw away what is in the boxes.
//
// ⚠️ IT ASKS FIRST, and that is not ceremony: what it discards can be an evening of lyrics, and
// the button sits one pixel from 💾 Save as… in a row people click quickly. The picker already
// stops for the same loss (`wouldLoseWork`); the difference is that there the discard is a side
// effect of choosing something else, and here it is the whole point — so the wording asks about
// the edits rather than warning about them.
//
// 📌 `noteForeverEdit()` AFTERWARD, because Generate-forever renders "what is on screen now".
// `fillForm` sets values programmatically, which fires no input event, so without this a run left
// going would keep making songs from the words the revert just threw away.
$('aceTplRevert')?.addEventListener('click', async () => {
  const t = TEMPLATES.find(x => x.id === CURRENT);
  if (!t) return;
  const ok = await modal(
    '↩ Revert changes',
    `Put <b>${esc(String(t.name || 'this template'))}</b> back as it was saved? The edits in the boxes below are thrown away.`,
    [
      { label: 'Cancel', value: 0 },
      { label: 'Discard my edits', class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  fillForm(t);
  paintPicker();
  saveDraft();
  noteForeverEdit();
});
$('aceTplSave')?.addEventListener('click', ev => saveTemplate(true, /** @type {FlashTarget} */ (ev.currentTarget)));

$('aceTplStar')?.addEventListener('click', async () => {
  const t = TEMPLATES.find(x => x.id === CURRENT);
  if (!t) return;
  try {
    await jpost('/acestep/templates/' + encodeURIComponent(t.id), { favorite: !t.favorite });
    await loadAceTemplates();
  } catch (e) {
    /* the picker repaints from the server on the next load */
  }
});

$('aceTplDel')?.addEventListener('click', async () => {
  const t = TEMPLATES.find(x => x.id === CURRENT);
  if (!t) return;
  const ok = await modal(
    'Delete “' + esc(t.name) + '”?',
    'The template goes, including its lyrics. Songs already in the library are not touched.',
    [
      { label: 'Cancel', value: 0 },
      { label: 'Delete', class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  try {
    await jdel('/acestep/templates/' + encodeURIComponent(t.id));
    CURRENT = null;
    fillForm(null);
    await loadAceTemplates();
    document.dispatchEvent(new CustomEvent('ace:template', { detail: { id: null } }));
  } catch (e) {
    await modal('Could not delete it', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  }
});

// ── 🔴 CLICKING A LIBRARY SONG PUTS THE WHOLE SONG BACK (§4.5.3) ──────────────────────────
// Selecting a library song restores its complete render configuration. The template is shown only
// when its saved fields still match the song; otherwise the form remains editable without claiming
// an unrelated template.
//
// 🔴 THE TEMPLATE IS DERIVED, NEVER TRUSTED. A song keeps its template's id, but a template is
// editable: edit one after rendering from it and the row's id still points at something that no
// longer describes the song. So the id only gets us a candidate, and the picker shows it ONLY if
// every identity field still agrees. Anything else is "— new song —", which is the honest answer
// — the form holds a song that no saved template would reproduce.
//
// ⚠️ THE COMPARISON IS ON THE §4.5.2 FIELDS ONLY, and deliberately not on the Advanced knobs:
// those are never written to a template, so including them would mean no song ever matched one.

//: Compared as strings so 120 and "120" agree, and so null, undefined and "" are all "unset" —
//: the store, the form and a JSON round trip each disagree about which of those they hand back.
/**
 * @param {Record<string, unknown>|null} a
 * @param {Record<string, unknown>|null} b
 * @returns {boolean}
 */
function fieldsAgree(a, b) {
  for (const [, key] of FIELDS) {
    /** @param {unknown} v */
    const norm = v => (key === 'instrumental' ? String(!!v) : v === null || v === undefined ? '' : String(v));
    if (norm(a ? a[key] : null) !== norm(b ? b[key] : null)) return false;
  }
  return true;
}

document.addEventListener('ace:loadsong', async ev => {
  const s = (ev.detail && ev.detail.song) || null;
  if (!s) return;
  // Only the FORM fill is guarded. The tray expands the lyrics either way — reading what a song
  // was made from destroys nothing, and a confirm in front of it would be ceremony.
  if (await wouldLoseWork()) return;
  // ⚠️ A row saved before 8.0-m9 has no `template`, so it falls back to the two fields it does
  // have. `s.name` is the LIBRARY name there, which is renameable and so is not necessarily the
  // title it rendered under — the best available answer, and only for those older rows.
  const f = s.template && typeof s.template === 'object' ? s.template : { name: s.name, caption: s.caption, lyrics: s.lyrics };
  const tpl = s.template_id ? TEMPLATES.find(t => t.id === s.template_id) : null;
  CURRENT = tpl && fieldsAgree(f, tpl) ? tpl.id : null;
  fillForm(f);
  paintPicker();
  // 📌 `null` settings means "this row never recorded them" (pre-8.0-m9) — leave the knobs alone
  // rather than wiping them on the strength of a row that never knew about them. `{}` DOES clear
  // them, because that is a song that recorded "everything was default".
  //
  // 🔴 THE SEED IS DELIBERATELY NOT RESTORED. Restoring it into collapsed Advanced settings would
  // silently make later renders reuse that seed, causing both cards to render the same take.
  //
  // ⚠️ WHAT MADE IT WRONG IS NOT THE VALUE, IT IS THE INVISIBILITY — and that is worth keeping
  // straight, because the obvious repair is to auto-open <details> and it would be worse. A pinned
  // seed makes BOTH cards render the same song, which is the opposite of what a two-card box is
  // for; setting that silently, behind a collapsed panel, turns every later Generate into one take
  // instead of two with no visible cause. A control that changes what Generate does has to be a
  // thing the user did, not a side effect of browsing the library. The seed remains on the row
  // where it can be read and copied (tray.js prints it in the meta line), which is the half of the
  // original ask that was actually about seeing the number.
  //
  // 📌 SO THE MERGE IS GONE AND NOTHING REPLACES IT. `writeAceAdvanced` clears every knob absent
  // from the object it is given (its own header explains why), and `seed` is a knob — so passing
  // `s.settings` through unchanged actively puts the box back to blank, i.e. to random. A stale
  // seed from a previous click, or one typed by hand and forgotten, cannot survive a row click.
  if (s.settings && typeof s.settings === 'object') writeAceAdvanced(s.settings);
  saveDraft();
  // Keep the picker and the library's filter agreeing — the same event the picker itself sends.
  document.dispatchEvent(new CustomEvent('ace:template', { detail: { id: CURRENT } }));
});

// ── 🔴 GENERATE FOREVER ───────────────────────────────────────────────────────────────────
// The control toggles server-owned continuous generation and shows how to stop it.
//
// 🔴 THE SERVER OWNS THE MODE; THIS PAINTS IT. `/acestep/jobs` reports `forever.on` on the poll
// the tray already makes, and `renderForever` runs off that. So closing and reopening the page
// shows the true state rather than this module's memory of what it last clicked — the same rule
// that made the card rows correct.
//
// 📌 AND THE TAB RE-ARMS IT AFTER A SERVICE RESTART. The flag is in the server's memory, so a
// Vocalis bounce clears it; `vocalis-ace-forever` in UIS is what remembers across that, and the
// re-arm below fires once on load. Deliberately here rather than on the server: state is not
// lost, but a box coming back from a reboot does not start generating on both cards with nobody
// watching. Someone has to open the page.
const FOREVER_KEY = 'vocalis-ace-forever';
let FOREVER_ON = false;

function foreverRecipe() {
  return { template: readForm(), template_id: CURRENT, settings: readAceAdvanced() };
}

/** @param {boolean} on */
function renderForever(on) {
  FOREVER_ON = !!on;
  const b = $('aceForever');
  const gen = /** @type {HTMLButtonElement} */ ($('aceGenBtn'));
  if (gen) gen.disabled = FOREVER_ON;
  if (!b) return;
  b.classList.toggle('on', FOREVER_ON);
  // ⚠️ The spinner is a SIBLING of the label, and the button is a column so it sits below the text.
  // `.spin`'s own right margin is canceled in CSS so it
  // sits centered instead of pushed left of where it would be inline.
  b.innerHTML = FOREVER_ON ? '<span>Generating forever (click to stop)</span><span class="spin"></span>' : '∞ Generate forever';
}

/** @param {boolean} on */
async function setForever(on) {
  if (on && (await refuseUselessRetake(readForm()))) return;
  // Optimistic, then corrected by the next poll — a two-second wait before the button admits it
  // was pressed is what makes people press it twice.
  renderForever(on);
  UIS.setItem(FOREVER_KEY, on ? '1' : '');
  try {
    const r = await jpost('/acestep/forever', on ? { on: true, ...foreverRecipe() } : { on: false });
    renderForever(r && r.on);
  } catch (e) {
    renderForever(false);
    UIS.setItem(FOREVER_KEY, '');
    await modal('Could not start Generate forever', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  }
}

$('aceForever')?.addEventListener('click', () => setForever(!FOREVER_ON));

// 🔴 A RUN ALREADY GOING PICKS UP WHAT IS ON SCREEN NOW. Edits push the current form to the server
// so the next run uses them without restarting continuous generation.
// The server cannot see the form, so every edit pushes it — debounced, because this fires on
// every keystroke in the lyrics box and the next song is minutes away, not milliseconds.
// ⚠️ ONLY WHILE THE MODE IS ON. Off, this is a POST per keystroke to change nothing.
/** @type {ReturnType<typeof setTimeout>|null} */
let FOREVER_PUSH = null;
function noteForeverEdit() {
  if (!FOREVER_ON) return;
  clearTimeout(FOREVER_PUSH ?? undefined);
  FOREVER_PUSH = setTimeout(() => {
    jpost('/acestep/forever', { on: true, refresh: true, ...foreverRecipe() }).catch(() => {
      /* the next edit pushes again; the run keeps its last good recipe */
    });
  }, 600);
}
$('aceForm')?.addEventListener('input', noteForeverEdit);
$('aceForm')?.addEventListener('change', noteForeverEdit);
// The Advanced knobs live outside #aceForm and have their own delegated listener, so they need
// their own hook or a steps change would never reach a run in progress.
document.addEventListener('change', ev => {
  if (ev.target && /** @type {Element} */ (ev.target).classList && /** @type {Element} */ (ev.target).classList.contains('aceadv'))
    noteForeverEdit();
});

// The tray polls /acestep/jobs; it forwards the flag rather than this module opening a second
// timer over the same route.
let FOREVER_REARMED = false;
document.addEventListener('ace:forever', ev => {
  const on = !!(/** @type {CustomEvent} */ (ev).detail && /** @type {CustomEvent} */ (ev).detail.on);
  renderForever(on);
  if (FOREVER_REARMED) return;
  // 🔴 NOT UNTIL THE DRAFT IS BACK. The re-arm sends the CURRENT form as the recipe, and the
  // tray's first poll can easily land before `loadAceTemplates` has restored it — re-arming then
  // would set the mode generating an empty song, forever. Leaving the flag unset simply lets the
  // next poll two seconds later try again, by which time the form is populated.
  if (!DRAFT_RESTORED) return;
  FOREVER_REARMED = true;
  if (!on && UIS.getItem(FOREVER_KEY) === '1') setForever(true);
});

// ── 🔴 8.1-m2b: THE LM WRITES INTO THE FORM, AND ONLY WHERE IT ACTUALLY SPOKE ─────────────
//
// The route returns just the fields the model filled in, and this writes just those. That is the
// whole contract, and it is what makes ✨ Tidy up safe to press on a half-finished song: a model
// that says nothing about the key must not blank a key the user typed. `Object.entries` over the
// answer rather than a walk of FIELDS is the shape that enforces it — there is no branch here
// that could write an empty string.
//
// ⚠️ IT MARKS THE FORM DIRTY, DELIBERATELY. What comes back is unsaved authored work, exactly
// like typing, so the ⚠ Unsaved words guard must fire if the user then clicks a library song.
// `fillForm` would have called `markClean`, which would say the opposite.
const LM_FIELDS = {
  caption: 'aceCaption',
  lyrics: 'aceLyrics',
  bpm: 'aceBpm',
  key_scale: 'aceKey',
  time_signature: 'aceTime',
  duration: 'aceDuration',
  vocal_language: 'aceLang',
};

/**
 * A button that carries the 5Hz-LM debounce timer and its pre-flash label — same expando
 * convention as `FlashTarget` above, but keyed on `HTMLButtonElement` because both callers pass
 * a `$(...)` result for a real <button> rather than an event target.
 * @typedef {HTMLButtonElement & {__lmTimer?: ReturnType<typeof setTimeout>|null, __lmLabel?: string}} LmButton
 */

/**
 * @param {LmButton} btn
 * @param {Record<string, unknown>} body
 * @param {string} what
 */
async function askTheLM(btn, body, what) {
  // Same trap `flashSaved` documents above: the original label is captured ONCE, per element,
  // never per press — a second press inside the ✓ window used to read the flash text back as
  // "original" and the button then said "✓ N fields filled in" forever.
  if (btn.__lmTimer) {
    clearTimeout(btn.__lmTimer);
    btn.__lmTimer = null;
  }
  if (!btn.__lmLabel) btn.__lmLabel = btn.innerHTML;
  const was = btn.__lmLabel;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>' + what;
  try {
    const r = await jpost('/acestep/compose', body);
    const song = (r && r.song) || {};
    let n = 0;
    for (const [key, id] of Object.entries(LM_FIELDS)) {
      if (!(key in song)) continue;
      const el = /** @type {HTMLInputElement|HTMLTextAreaElement} */ ($(id));
      if (!el) continue;
      el.value = song[key];
      n++;
    }
    if (!n) {
      await modal('Nothing came back', 'The language model answered, but with none of the fields this form uses.', [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
      return;
    }
    // The words are now unsaved work — see the note above. Both of these run on a real edit
    // and neither fires for a programmatic one, so they are called by hand.
    CLEAN = null;
    saveDraft();
    paintDirty();
    noteForeverEdit();
    btn.innerHTML = `✓ ${n} field${n === 1 ? '' : 's'} filled in`;
    btn.__lmTimer = setTimeout(() => {
      btn.innerHTML = was;
      btn.__lmTimer = null;
    }, 2500);
    return;
  } catch (e) {
    // The server's sentence is the useful half — "LLM not initialized. Set ACESTEP_INIT_LLM=
    // true in .env to enable" is exactly what a generic failure would hide.
    await modal('The 5Hz LM could not write it', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  } finally {
    btn.disabled = false;
    if (btn.innerHTML.startsWith('<span class="spin"')) btn.innerHTML = was;
  }
}

$('aceWrite')?.addEventListener('click', () => {
  const f = readForm();
  // A local alias, not an inline cast: Prettier hoists a `@type` comment that opens a
  // parenthesized group out of it, which would silently re-aim this one at the whole `(… || '')`.
  const q = /** @type {HTMLInputElement} */ ($('aceQuery'));
  return askTheLM(
    /** @type {LmButton} */ ($('aceWrite')),
    {
      query: (q?.value || '').trim(),
      instrumental: !!f.instrumental,
      // ⚠️ ACE-Step reads the language out of the DESCRIPTION unless this names one that is not
      // en/unknown (`llm_generation_inputs.py:124`). So a form left on the "en" default lets
      // "sung in Japanese" in the description actually win, which is what someone typing that
      // means. Sending "en" hard would silently override them.
      vocal_language: f.vocal_language && f.vocal_language !== 'en' ? f.vocal_language : '',
    },
    'Writing…',
  );
});

$('aceTidy')?.addEventListener('click', async () => {
  const f = readForm();
  if (!(f.caption || '').trim() && !(f.lyrics || '').trim()) {
    await modal(
      'Nothing to tidy up',
      'Put a caption or some lyrics in first — this reworks what is already there. ' +
        'To start from a description, use ✨ Write it for me.',
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    return;
  }
  return askTheLM(
    /** @type {LmButton} */ ($('aceTidy')),
    {
      format: true,
      caption: f.caption || '',
      lyrics: f.lyrics || '',
      bpm: f.bpm,
      duration: f.duration,
      keyscale: f.key_scale,
      timesignature: f.time_signature,
      language: f.vocal_language,
    },
    'Tidying…',
  );
});

// 🔴 GENERATE. One press = one song per LIVE card (§4.5.3) — the count is the server's decision,
// not this button's, because only the server knows which backends are up and authorized.
//
// The two halves of the request are the §4.5.2 split, on the wire: `template` is what the song
// IS, `settings` is how well it renders. They never overlap, and the server drops anything in
// `template` it does not recognize, so a stray render knob cannot be persisted onto a song.
// ⚠️ THE ONE PRESS-TIME CHECK THE SERVER CANNOT MAKE FOR US: variance 0 is a VALID value that
// does a useless thing. `inference.py:169` — the seed is only consumed above zero, so a Retake
// at 0 spends a real render reproducing the original exactly. Blank is fine (the server floors
// it to 0.2); an explicit 0 gets a sentence instead of a duplicate song. Shared by Generate and
// Generate-forever, which would otherwise mint duplicates by the dozen, unattended.
/** @param {AceFormData} f */
async function refuseUselessRetake(f) {
  if ((f.mode || 'custom') !== 'retake' || f.retake_variance !== 0) return false;
  await modal(
    'Variance 0 re-renders the original exactly',
    'Retake nudges the original seed, and the backend only uses it when Variance is above ' +
      'zero — at 0 the press would spend a whole render reproducing the song you already have. ' +
      'Raise Variance (0.2 is the usual nudge), or clear it to use the default.',
    [{ label: 'OK', class: 'primary', value: 1 }],
  );
  return true;
}

/** How many songs one press will queue: one per AUTHORIZED card, matching the “×N” header and
 * `s.instances`, the ACE-Step setting under ⚙ Settings ▸ Devices. */
let ACE_CARDS = 0;

/** The Generate button's resting label — what pressing it will DO, in songs.
 *
 * ⚠️ FALLS BACK TO THE OLD WORDING WHEN THE COUNT IS UNKNOWN (no poll yet, or no backend
 * configured). "▶ Generate 0" would be a promise the button cannot keep, and a bare "▶ Generate"
 * says less than the sentence it replaced. */
function aceGenLabel() {
  return ACE_CARDS > 0 ? `▶ Generate ${ACE_CARDS}` : '▶ Generate (add to queue)';
}

function paintAceGenLabel() {
  const b = /** @type {LmButton|null} */ ($('aceGenBtn'));
  // 🔴 NEVER OVER A PRESS IN FLIGHT. The poll runs every 2 s and the flash lasts 3, so without
  // this the status tick would wipe "▶ 2 started" a second after it appeared — replacing one
  // wrong label with a different wrong behavior.
  if (!b || b.disabled || b.__lmTimer) return;
  b.innerHTML = aceGenLabel();
}

onAceStatus((/** @type {{instances?: number}} */ s) => {
  const n = Number(s && s.instances) || 0;
  if (n === ACE_CARDS) return; // the poll is every 2 s; only repaint when the answer changed
  ACE_CARDS = n;
  paintAceGenLabel();
});

$('aceGenBtn')?.addEventListener('click', async () => {
  const btn = /** @type {LmButton} */ ($('aceGenBtn'));
  const f = readForm();
  if (!(f.caption || '').trim() && !(f.lyrics || '').trim() && !f.instrumental) {
    await modal(
      'Nothing to generate',
      'Give it a caption (the style) or some lyrics. For a track with no vocals, tick ' + 'Instrumental.',
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    return;
  }
  if (await refuseUselessRetake(f)) return;
  // 🔴 THE RESTING LABEL IS RECOMPUTED, NEVER REMEMBERED — and remembering is what broke it.
  // This read `const was = btn.textContent` AT PRESS TIME, so a second Generate inside the
  // three-second "▶ N started" window captured that transient label as the original and restored
  // it permanently.
  // 📌 THE SAME TRAP `askTheLM` BELOW ALREADY DOCUMENTS, in this file: *"a second press inside
  // the ✓ window used to read the flash text back as 'original'."* That one fixes it by
  // remembering the label per ELEMENT; this button cannot, because its label carries the CARD
  // COUNT and so goes stale the moment a card is ticked or a backend stops. Deriving it is the
  // stronger answer — there is no captured string to be wrong.
  // ⚠️ The timer is still canceled per press: two presses three seconds apart would otherwise
  // race, and the loser would repaint over the winner's spinner.
  if (btn.__lmTimer) {
    clearTimeout(btn.__lmTimer);
    btn.__lmTimer = null;
  }
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Starting…';
  try {
    const r = await jpost('/acestep/generate', {
      template: f,
      template_id: CURRENT,
      settings: readAceAdvanced(),
    });
    // The tray polls every 2 s and will pick these up; nothing to render here.
    btn.textContent = `▶ ${(r.jobs || []).length} started`;
    btn.__lmTimer = setTimeout(() => {
      paintAceGenLabel();
      btn.__lmTimer = null;
    }, 3000);
  } catch (e) {
    paintAceGenLabel();
    // The server's message is the useful part — "no ACE-Step backend is running — press Start
    // ACE-Step in the header" is precisely the thing a generic failure would hide.
    await modal('Could not start', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  } finally {
    btn.disabled = false;
  }
});
