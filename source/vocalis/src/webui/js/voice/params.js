// voice/params.js — the per-voice delivery settings for the two VOICE-KEYED tabs, Book and
// Playground (7.3-m12c).
//
// 12 lines out of index.html's `── per-voice settings for the voice-keyed tabs ──` banner. Each
// voice remembers its own exaggeration/CFG/temp, PER CONTEXT (the `book` and `playground` sections
// of voice_settings.yaml): selecting a voice LOADS its entry for that panel, and auditioning or
// generating SAVES it. Nomi and SillyTavern settings are per-ENTITY and never touch these.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WHY THIS IS ITS OWN FILE AND NOT PART OF `ui/audition.js`, WHICH IS ITS BIGGEST CALLER.
// Because four modules read it and one of them would be importing BACKWARD. `ui/audition.js`
// needs `BOOK_F`/`PG_F`/`curParams`; `pg/playground.js` needs `saveVoiceSettings`/`curParams`/
// `PG_F`; `sys/devices.js` needs `restoreVoice`/`BOOK_F`/`PG_F` right after it fills the two
// selects; `book/job.js` reads the same three knob ids. Putting these in audition.js gives
// audition ⇄ playground and audition ⇄ devices — and the whole point of the m8a/m2b/m9a/m6e
// pattern is that **a thing several modules read goes in a file of its own with no dependencies
// pointing back at its readers.** This is that pattern for the fifth time, and the first where
// the shared thing is neither state nor a widget but a pair of FIELD MAPS.
//
// ⚠️ THE TWO `change` LISTENERS DID NOT COME WITH IT, and that is deliberate. They end in
// `bookUpdateAudition(true)` / `pgUpdateAudition(true)`, so keeping them here would import
// audition.js and produce exactly the cycle described above. They live in `ui/audition.js` beside
// the functions they call, which imports FROM here — one direction, no cycle. The listeners are
// also the only part of this area that touches ids `ui/voicepicker.js` paints, so they belong with
// the other module that already depends on that paint.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — all six. There is nothing private here; every one has a caller in another
// file, which is what made this an obvious file rather than a judgment call.
//
//   BOOK_F, PG_F        the knob-id + context maps. Data, not behavior: `{exag,cfg,temp,ctx}`
//   loadVoiceSettings   fill the three knobs from the server for one voice + context
//   saveVoiceSettings   the other direction — fire-and-forget; auditioning and generating both do it
//   curParams           read the three knobs off the DOM as a `{exaggeration,cfg,temperature}`
//   restoreVoice        reselect the remembered voice after a list load, and load its knobs
//
// ⚠️ `restoreVoice` READS `UIS`, which is still a page global — the last one, and the only name in
// 7.3 that was never movable while an inline script existed (§11.2). It resolves at CALL time on
// the global scope chain, which a module may always do; it becomes an import at m13, when `UIS`
// becomes `js/util/uistate.js` and the classic script is deleted.
//
// 📌 IT WIRES NOTHING AND PAINTS NOTHING. Six definitions, no listener, no DOM read at module
// level — so unlike most of this tree the export list really is the whole story, and this file
// can be reasoned about without a page.

import { $ } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { jget } from '../util/http.js';

// ── per-voice settings for the voice-keyed tabs (the book/playground sections
//    of voice_settings.yaml): selecting a voice LOADS its entry for this
//    panel's context; auditioning/generating SAVES it. (Nomi/ST settings are
//    per-entity — their tabs never touch these.) ──
/** DOM ids for the three delivery sliders in one panel; this is data, not behavior.
 * * @typedef {object} VKnobIds
 * @property {string} exag  The exaggeration slider's element id.
 * @property {string} cfg   The CFG slider's element id.
 * @property {string} temp  The temperature slider's element id.
 */
/**
 * A knob map that ALSO names a `voice_settings.yaml` section — the voice-keyed tabs only.
 * Selecting a voice LOADS its entry for this panel's context; auditioning/generating SAVES it.
 * `BOOK_F` and `PG_F` are the only two, one per caller (Book, Playground).
 * @typedef {VKnobIds & {ctx: string}} VFieldMap
 */
/** @type {VFieldMap} */
export const BOOK_F = { exag: 'exag', cfg: 'cfg', temp: 'temp', ctx: 'book' };
/** @type {VFieldMap} */
export const PG_F = { exag: 'pgExag', cfg: 'pgCfg', temp: 'pgTemp', ctx: 'playground' };
/** @param {string} voice @param {VFieldMap} f */
export async function loadVoiceSettings(voice, f) {
  if (!voice) return;
  try {
    const s = await jget('/voices/' + encodeURIComponent(voice) + '/settings?context=' + (f.ctx || 'book'));
    if (s.exaggeration != null) /** @type {HTMLInputElement} */ ($(f.exag)).value = s.exaggeration;
    if (s.cfg != null) /** @type {HTMLInputElement} */ ($(f.cfg)).value = s.cfg;
    if (s.temperature != null) /** @type {HTMLInputElement} */ ($(f.temp)).value = s.temperature;
  } catch (e) {}
}
/**
 * @param {string} voice
 * @param {{exaggeration:number,cfg:number,temperature:number}} v
 * @param {string} [ctx] - defaults to 'book'.
 */
export function saveVoiceSettings(voice, v, ctx) {
  if (!voice) return; // nothing to save for "(model default)"
  fetch('/voices/' + encodeURIComponent(voice) + '/settings?context=' + (ctx || 'book'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exaggeration: v.exaggeration, cfg: v.cfg, temperature: v.temperature }),
  }).catch(() => {});
}
// 🔴 THE PARAMETER IS `VKnobIds`, NOT `VFieldMap` — DELIBERATELY NARROWER THAN THIS FILE'S OWN
// BOOK_F/PG_F. `curParams` never reads `.ctx`, and two callers outside this directory
// (`ui/audition.js`'s per-cluster helper, `st/chars.js`'s per-row audition) pass a plain
// `{exag,cfg,temp}` with no `ctx` at all — `ui/audition.js` even names the structural match on
// purpose in its own `DeliveryFields` typedef. Requiring `ctx` here rejects both call sites for a
// field the function is provably indifferent to.
//
// 📌 TWO WRITERS REACHED THIS INDEPENDENTLY IN THE SAME PASS — the `voice/` annotator hit it as a
// cross-file regression from its own first attempt, and the orchestrator hit it as the `ui/`+`st/`
// boundary error. Agreement from two directions is why it was fixed by narrowing the SIGNATURE
// rather than by widening the two callers, which is the change that would have been wrong.
/**
 * @param {VKnobIds} f
 * @returns {{exaggeration:number,cfg:number,temperature:number}}
 */
export function curParams(f) {
  const ex = /** @type {HTMLInputElement} */ ($(f.exag));
  const cf = /** @type {HTMLInputElement} */ ($(f.cfg));
  const tp = /** @type {HTMLInputElement} */ ($(f.temp));
  return { exaggeration: +ex.value, cfg: +cf.value, temperature: +tp.value };
}
/** @param {string} selId @param {string} lsKey @param {VFieldMap} f */
export function restoreVoice(selId, lsKey, f) {
  let v = '';
  try {
    v = UIS.getItem(lsKey) || '';
  } catch (e) {}
  const sel = /** @type {HTMLSelectElement} */ ($(selId));
  if (v && [...sel.options].some(o => o.value === v)) {
    sel.value = v;
    return loadVoiceSettings(v, f);
  }
}
