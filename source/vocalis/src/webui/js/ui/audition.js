// ui/audition.js — ONE AUDITION, FIVE TABS (7.3-m2).
//
// ▶ Audition is the same act everywhere it appears — Book, Playground, Nomi, SillyTavern and
// the Nomi/ST default clusters — and this file is the reason it behaves identically in all of
// them: one render call, one cancel, one "is there already a take for these exact inputs?"
// matcher, one player. Five tabs each owning their own version of that would quietly drift.
//
// 🔴 THE GROUPING IS THE RENDER AND ITS MIRROR, NOT "audition-ish things".
// `runAudition` BAKES a take; `updateAudition` decides whether the little player next to the
// button should be showing one. They have to move together because they are two halves of one
// invariant: the render sends `enhance:false`, so the match must exclude enhanced clips, or the
// player sits there waiting for an enhanced clip that is never made and never appears. Split
// them across two files and the next person changes one side of that.
//
// `pgTakeMatch`/`pgUpdateTake` are the same idea over the Playground's CURRENT text rather than
// the fixed audition phrase, and `hideAudio` is the shared "stop it AND clear it" that every one
// of these players needs — a hidden <audio> keeps playing with no controls to stop it. That is
// why the six media trays (voice swap, stem sets, training) call `hideAudio` too.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 `AUDITION_TEXT` IS DUPLICATED ON PURPOSE — DO NOT DELETE EITHER COPY.
//
// The inline script reads it at PARSE TIME:
//   `try{$('pgText').value=UIS.getItem('vocalis-pg-text')||AUDITION_TEXT;}catch(e){…}`
// which is one of the ten top-level `UIS.getItem` restores of DESIGN_7_3_FRONTEND_SPLIT.md
// §3.1a. A `type="module"` script has not run at that instant, so a module-only `AUDITION_TEXT`
// would be `undefined` there and the Playground box would come up holding the *string*
// "undefined" on a browser with no saved text.
//
// ⚠️ AND THE DRIFT IS SILENT, WHICH IS WHY IT NEEDS A TEST rather than a comment. The phrase is
// half of the cached-audition identity (`c.text===AUDITION_TEXT` in `auditionMatchFor`) and half
// of the server-side sweep (`{audition_text:AUDITION_TEXT}` in `wireClearCache`). Two copies that
// disagree by one comma do not throw: the player simply never appears again, and the sweep
// silently stops matching the previews it is meant to delete.
//
// REMOVAL CONDITION — the same one `$` and `esc` carry: delete the INLINE copy, in the same
// commit, when its last parse-time reader moves (that `pgText` restore, i.e. m12), and drop it
// from the drift test's parameter list then. Not before.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ NAMES THIS FILE STILL RESOLVES AS GLOBALS, AND THEY ARE DELIBERATE (§3.1, and see the
// same note at the top of `main.js`). module → inline AT RUNTIME always works: a module body
// resolves a global at CALL time, and every one of these is named inside a function that cannot
// run before the document is parsed. They are NOT imported and NOT duplicated — each becomes a
// real `import` when its own area becomes a module, and nothing else here changes:
//
//   VocalisStreamPlayer  ← /webui/stream_player.js (a classic <script>, a real window global)
//   pgClipUrl, loadPgLib, pgLib   ← the Playground → js/pg/playground.js
//   enh                  ← the enhance area       → js/sys/enhance.js
//   state                ← the global app state
//   PG_F, BOOK_F         ← the two field maps     → js/pg/playground.js / js/book/*
//
// 🔴 `state`, `enh`, `pgLib`, `PG_F` and `BOOK_F` are top-level `const`s in a classic script, so
// they live in the global LEXICAL environment and are NOT properties of `window`. A module can
// still read them — the scope chain reaches the same environment — but `window.PG_F` is
// `undefined`, so never reach for one through `window` and never test for one that way.
//
// 📌 `curParams` IS NOT HERE, THOUGH §4 OF THE DESIGN DOC LISTS IT. It is defined next to
// `saveVoiceSettings` and `restoreVoice`, well above this banner, and every one of its callers is
// a *wiring* statement rather than anything in this file — nothing below names it. It belongs
// with the voice-settings group it already sits in; moving it here would have been filing by
// title instead of by coupling.

import { $, esc } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { jget, jpost } from '../util/http.js';
import { modal } from './modal.js';
import { enh } from '../sys/enhance.js'; // 7.3-m13: was a shim read
// 🔴 7.3-m4t — see the cluster-wiring note further down. `voiceLabelOf` renders the voice's label
// in the Clear-cached confirm. js/ui/voicepicker.js imports only util/dom.js and ui/fav.js, so
// there is no cycle back to this file — checked before adding the line.
//
// ⚠️ `stepVoice` IS NOT IN THIS IMPORT, AND THE FIRST DRAFT OF THIS COMMIT PUT IT THERE. §4's file
// table lists it under `ui/voicepicker.js`, which is the PLAN; it is still an inline function in
// index.html (m4q took `voiceClusterHTML`/`voiceOptionsHTML`/`useDefaultLabel` and left it). A
// named import of something the target does not export is a SyntaxError thrown before this
// module's first statement — so the page loaded no audition code at all, and three browser specs
// went red alongside `test_every_named_import_is_actually_exported_by_its_target`, which is the
// guard m4 added for exactly this. 📌 **§4 is a plan, not an inventory. Grep the target's exports
// before importing a name out of it.** `wireAudCluster` reaches `stepVoice` as an inline global at
// call time instead, which is what the code did before it moved and is always safe (§3.1).
import { voiceLabelOf } from './voicepicker.js';
import { stepVoice } from './voicepicker.js'; // 7.3-m6d: was an inline global
import { pgLibLoad } from '../pg/pgstate.js'; // 7.5.6 — was `loadPgLib` from playground.js
import { pgClipUrl, pgLib } from '../pg/pgstate.js'; // 7.3-m6e: dependency-free
// ✅ 7.3-m12c. `BOOK_F`, `PG_F` and `curParams` were inline globals this file had been reaching for
// since m3e — `updateAudition`'s two wrappers below use the field maps, and the #audBtn wiring that
// arrived in this commit uses all four names. js/voice/params.js imports only util/dom.js and
// util/http.js, so there is no cycle back here; the two `change` listeners that DO need
// bookUpdateAudition/pgUpdateAudition live in this file rather than there, which is what keeps the
// edge one-directional. That module's header has the argument.
import { BOOK_F, PG_F, curParams, loadVoiceSettings, saveVoiceSettings } from '../voice/params.js';

/** State for the Audition/Cancel button is stored on its element so the shared handler can serve multiple panels.
 * * @typedef {HTMLButtonElement & {_audCancel?: boolean, _audJob?: string|null, _audStream?: VocalisStreamHandle|null}} AuditionBtn
 */

/**
 * The on-screen delivery knobs, as `voice/params.js`'s `curParams()` reads them off the DOM.
 * @typedef {object} DeliveryParams
 * @property {number} exaggeration
 * @property {number} cfg
 * @property {number} temperature
 */

/**
 * The three knob ids for one voice cluster. `BOOK_F`/`PG_F` (`voice/params.js`) carry a fourth
 * field, `ctx`; structurally compatible here because every reader in this file only ever
 * touches these three.
 * @typedef {object} DeliveryFields
 * @property {string} exag
 * @property {string} cfg
 * @property {string} temp
 */

/** Minimal Playground clip fields read by audition logic.
 * * @typedef {object} ClipLite
 * @property {string} ref
 * @property {string} kind
 * @property {boolean} [enhanced]
 * @property {string} [text]
 * @property {string} [voice]
 * @property {number|null} [exaggeration]
 * @property {number|null} [cfg]
 * @property {number|null} [temperature]
 * @property {boolean} [narrate_actions]
 * @property {number} [created_ts]
 */

// ── Audition: render a preview with the selected voice + ALL current params (reuses /playground/generate) ──
export const AUDITION_TEXT = 'The quick brown fox jumps over the lazy dog, and the sly cat watches from the warm windowsill.';
// Audition = a normal playground render of the standard phrase (it lands in the
// library like any clip; re-auditioning bakes a FRESH take that replaces it —
// the player next to the button replays the stored one). Auditions STREAM (3.x).
// An audition is a REAL render on the GPU — a long voice on a busy box takes as long as it
// takes — and the button used to gray itself out and say "Rendering…" with no way back. So
// the button IS the cancel while it runs: same /book/cancel the Playground's ■ Cancel
// posts, so a stopped audition banks its chunks and behaves like any other stopped render
// (audition again with the same settings and it resumes). State hangs off the BUTTON
// element, because one function serves four of them (Book, Playground, Nomi, SillyTavern).
/** @param {AuditionBtn} btn */
export async function auditionCancel(btn) {
  btn._audCancel = true; // also covers the gap BEFORE the job id lands
  // `AuditionBtn` intersects `VEl`, not `HTMLButtonElement`, because the four call sites all hand
  // it `$(...)` — so the kind is stated at the two lines that need it rather than on the typedef.
  /** @type {HTMLButtonElement} */ (btn).disabled = true;
  btn.innerHTML = '<span class="spin"></span>Canceling…';
  if (btn._audStream) {
    try {
      btn._audStream.stop();
    } catch (e) {}
  }
  if (btn._audJob) {
    try {
      await jpost('/book/cancel/' + btn._audJob, {});
    } catch (e) {}
  }
}
/**
 * @param {string} voice
 * @param {DeliveryParams} p
 * @param {AuditionBtn} btn
 * @param {VEl} a — the `<audio>` element the take plays in.
 */
export async function runAudition(voice, p, btn, a) {
  // The re-entry guard lives HERE, not in the four places that wire this up — Nomi and
  // SillyTavern bind runAudition directly, and without it a second click would start a
  // second render on top of the first instead of stopping it.
  if (btn._audRunning) return auditionCancel(btn);
  const lbl = btn.textContent,
    cls = btn.className;
  btn._audRunning = true;
  btn._audCancel = false;
  btn._audJob = null;
  btn._audStream = null;
  btn.className = cls + ' danger';
  btn.textContent = '■ Cancel';
  try {
    // Auditions are NOT enhanced, explicitly. An audition answers "is this the right voice
    // and delivery?", and enhancement doesn't move the identity band (1–8 kHz survives
    // within 1.3 dB) — so it would add GPU seconds and triple the file for a preview you
    // page through with ◀ ▶, and answer nothing. The Book and Nomi/SillyTavern tabs share
    // this button and have no Enhance box at all, so it must not read one.
    const body = {
      text: AUDITION_TEXT,
      voice,
      exaggeration: p.exaggeration,
      cfg: p.cfg,
      temperature: p.temperature,
      enhance: false,
    };
    const r = await jpost('/playground/stream', body);
    btn._audJob = r.job_id;
    // Canceled while the request was still in flight: the job exists now, so stop it.
    if (btn._audCancel) {
      try {
        await jpost('/book/cancel/' + r.job_id, {});
      } catch (e) {}
      throw new Error('canceled');
    }
    let ref = r.clip;
    if (!ref) {
      // Play the live stream for audio, but DECIDE COMPLETION FROM THE SERVER — the clip
      // landing on disk — never from the browser <audio> 'ended' event. Relying on 'ended'
      // hung the button forever whenever it didn't fire: Chrome silently blocking autoplay of
      // the headless audition audio, or a stream that didn't close, left the promise unsettled
      // even though the render had finished and the clip was on disk — and Cancel couldn't
      // break out of it either. Polling /book/status is the authoritative signal (the same one
      // the non-streaming path always used) and lets a Cancel land, checked every tick.
      if (r.stream_url) {
        btn._audStream = VocalisStreamPlayer.play({
          streamUrl: r.stream_url,
          statusUrl: r.status_url,
          onError: () => {},
        });
      } // live audio only
      for (let i = 0; ; i++) {
        await new Promise(x => setTimeout(x, 500));
        if (btn._audCancel) throw new Error('canceled');
        const s = await jget('/book/status/' + r.job_id);
        if (s.status === 'done') {
          ref = s.clip;
          break;
        }
        if (['failed', 'canceled'].includes(s.status)) throw new Error(s.error || 'audition ' + s.status);
        if (i >= 600) throw new Error('audition timed out');
      } // ~5 min; a cold first render is slow
    }
    /** @type {HTMLAudioElement} */ (a).src = pgClipUrl(ref);
    a.style.display = '';
    if (!r.stream_url) /** @type {HTMLAudioElement} */ (a).play().catch(() => {}); // streamed auditions already played live
    pgLibLoad(); // it's a real clip now — reflect it in the library
  } catch (e) {
    // A cancel the user ASKED for is not a failure and must not pop an error at them. The
    // banked chunks are kept either way, so the library gets the partial like any other
    // stopped render.
    if (btn._audCancel) pgLibLoad();
    else await modal('Audition failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    btn._audRunning = false;
    btn._audJob = null;
    btn._audStream = null;
    /** @type {HTMLButtonElement} */ (btn).disabled = false;
    btn.className = cls;
    btn.textContent = lbl;
  }
}

// ── cached-audition awareness (Playground AND Book — one implementation over the
// field maps): the player next to Audition shows ONLY when a stored audition matches
// the tab's current voice + settings — appear/vanish live as the dropdown or knobs
// change. Seedless: same inputs = the stored take (newest wins).
// Auditions are deliberately NOT enhanced (runAudition sends enhance:false), so the match
// has to say so too — otherwise the player next to ▶ Audition would sit there waiting for
// an enhanced clip that is never made, and never appear.
/**
 * @param {DeliveryFields} f
 * @param {string} voiceId
 * @returns {ClipLite|null}
 */
function auditionMatchFor(f, voiceId) {
  const v = /** @type {HTMLSelectElement} */ ($(voiceId)).value;
  /** @param {number|string|null|undefined} a - a stored knob is `number|null`; `+null` is 0
   *    and `+undefined` is NaN, so an absent one never matches.
   *  @param {number|string|null|undefined} b */
  // `Number()` rather than `+` with a cast: both run ToNumber, so `Number(null)` is 0 and
  // `Number(undefined)` is NaN exactly as before — but its parameter is `any`, so the nullable
  // knob needs no assertion that it is not null when it demonstrably can be.
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
  const m = pgLib.items.filter(
    /** @type {(c: ClipLite) => boolean} */ (
      c =>
        c.kind !== 'partial' &&
        !c.enhanced &&
        c.text === AUDITION_TEXT &&
        (c.voice || '') === v &&
        near(c.exaggeration, /** @type {HTMLInputElement} */ ($(f.exag)).value) &&
        near(c.cfg, /** @type {HTMLInputElement} */ ($(f.cfg)).value) &&
        near(c.temperature, /** @type {HTMLInputElement} */ ($(f.temp)).value)
    ),
  );
  m.sort(/** @type {(a: ClipLite, b: ClipLite) => number} */ ((a, b) => (b.created_ts || 0) - (a.created_ts || 0)));
  return m[0] || null;
}
// The Playground's "existing take" player: the same input-match idea over the
// CURRENT text — visible when the library already holds a take for these exact
// inputs. Generate always re-renders and replaces it; this control just plays it.
// Enhance participates here for the same reason it participates in the server's clip_hash:
// the enhanced and un-enhanced takes of one text are two different clips in two different
// files. Without it, this player would offer the enhanced take as "the stored take" for an
// un-enhanced render, and the wrong audio would play.
/** @returns {ClipLite|null} */
export function pgTakeMatch() {
  const t = /** @type {HTMLTextAreaElement} */ ($('pgText')).value,
    v = /** @type {HTMLSelectElement} */ ($('pgVoice')).value,
    na = /** @type {HTMLInputElement} */ ($('pgActions')).checked;
  const en = enh.ok && /** @type {HTMLInputElement} */ ($('pgEnh')).checked;
  /** @param {number|string|null|undefined} a - a stored knob is `number|null`; `+null` is 0
   *    and `+undefined` is NaN, so an absent one never matches.
   *  @param {number|string|null|undefined} b */
  // `Number()` rather than `+` with a cast: both run ToNumber, so `Number(null)` is 0 and
  // `Number(undefined)` is NaN exactly as before — but its parameter is `any`, so the nullable
  // knob needs no assertion that it is not null when it demonstrably can be.
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
  const m = pgLib.items.filter(
    /** @type {(c: ClipLite) => boolean} */ (
      c =>
        c.kind !== 'partial' &&
        c.text === t &&
        (c.voice || '') === v &&
        near(c.exaggeration, /** @type {HTMLInputElement} */ ($('pgExag')).value) &&
        near(c.cfg, /** @type {HTMLInputElement} */ ($('pgCfg')).value) &&
        near(c.temperature, /** @type {HTMLInputElement} */ ($('pgTemp')).value) &&
        (c.narrate_actions !== false) === na &&
        !!c.enhanced === en
    ),
  );
  m.sort(/** @type {(a: ClipLite, b: ClipLite) => number} */ ((a, b) => (b.created_ts || 0) - (a.created_ts || 0)));
  return m[0] || null;
}
// Hiding a playing <audio> does NOT stop it — the sound keeps going with no
// visible controls to stop it. Every cache-driven hide goes through here:
// pause first, then hide + unload (dataset stamps cleared so a later re-show
// re-derives its src from scratch).
/** @param {VEl} a */
export function hideAudio(a) {
  try {
    /** @type {HTMLAudioElement} */ (a).pause();
  } catch (e) {}
  a.style.display = 'none';
  a.removeAttribute('src');
  delete a.dataset.url;
  delete a.dataset.ref;
}
export function pgUpdateTake() {
  const a = /** @type {HTMLAudioElement} */ ($('pgTakeOut')),
    c = pgTakeMatch();
  if (state.pgStream) {
    hideAudio(a);
    return;
  } // the live stream player owns the slot
  // created_ts busts the browser's metadata cache after a re-render OVERWRITES the
  // same URL — otherwise the player keeps the old take (and its old duration).
  if (c) {
    const u = pgClipUrl(c.ref) + '?v=' + Math.round(c.created_ts || 0);
    if (a.getAttribute('src') !== u) {
      a.src = u;
      a.load();
    }
    a.style.display = '';
  } else hideAudio(a);
}
/**
 * @param {DeliveryFields} f
 * @param {string} voiceId
 * @param {string} audId
 * @param {boolean} [play] - autoplay the match once found (paging voices).
 */
export function updateAudition(f, voiceId, audId, play) {
  const a = /** @type {HTMLAudioElement} */ ($(audId)),
    c = auditionMatchFor(f, voiceId);
  if (c) {
    const u = pgClipUrl(c.ref);
    if (!a.src || !a.src.endsWith(u)) a.src = u;
    a.style.display = '';
    a.title = 'cached audition — the stored take for these inputs';
    if (play) a.play().catch(() => {});
  } // paging voices: a cached audition plays right away
  else hideAudio(a);
}
/** @param {boolean} [play] */
export function pgUpdateAudition(play) {
  updateAudition(PG_F, 'pgVoice', 'pgAudOut', play);
}
/** @param {boolean} [play] */
export function bookUpdateAudition(play) {
  updateAudition(BOOK_F, 'voice', 'audOut', play);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE FOUR WIRINGS BELOW ARRIVED AT 7.3-m12c, AND ALL FOUR TOUCH IDS `ui/voicepicker.js` PAINTS
// (#voice, #pgVoice, #audBtn, #pgAudBtn, #audOut, #pgAudOut). That is safe here because this file
// already imports from voicepicker.js, so its paint has run before this body does — an ORDER
// guaranteed by the import graph rather than by index.html's shim listing one file above another.
//
// ⚠️ THE TWO `change` LISTENERS ARE HERE RATHER THAN IN js/voice/params.js, WHICH OWNS EVERYTHING
// ELSE THEY CALL. They end in bookUpdateAudition/pgUpdateAudition, so putting them beside
// loadVoiceSettings would make params.js import this file while this file imports it — a cycle,
// for two listeners. Filing by what a line CALLS beats filing by what it reads.
//
// 📌 The page's note said moving the #audBtn wiring "would drag curParams, saveVoiceSettings,
// BOOK_F and PG_F into the module as four more inline-global reaches, for nothing." That was true
// and is now the opposite: they are imports, so this commit took four reaches OUT of this file
// while bringing the wiring in.
/** @type {VEl} */ ($('voice')).addEventListener('change', async () => {
  const v = /** @type {HTMLSelectElement} */ ($('voice')).value;
  try {
    UIS.setItem('vocalis-book-voice', v);
  } catch (e) {}
  await loadVoiceSettings(v, BOOK_F);
  bookUpdateAudition(true);
}); // cached audition auto-plays when paging voices
/** @type {VEl} */ ($('pgVoice')).addEventListener('change', async () => {
  const v = /** @type {HTMLSelectElement} */ ($('pgVoice')).value;
  try {
    UIS.setItem('vocalis-pg-voice', v);
  } catch (e) {}
  await loadVoiceSettings(v, PG_F);
  pgUpdateAudition(true);
}); // after the voice's saved knobs land; cached audition auto-plays
/** @type {VEl} */ ($('audBtn')).onclick = () => {
  const b = /** @type {AuditionBtn} */ ($('audBtn'));
  if (b._audRunning) return auditionCancel(b);
  // audition saves these as the voice's book defaults
  saveVoiceSettings(/** @type {HTMLSelectElement} */ ($('voice')).value, curParams(BOOK_F), BOOK_F.ctx);
  runAudition(/** @type {HTMLSelectElement} */ ($('voice')).value, curParams(BOOK_F), b, /** @type {VEl} */ ($('audOut')));
};
/** @type {VEl} */ ($('pgAudBtn')).onclick = () => {
  const b = /** @type {AuditionBtn} */ ($('pgAudBtn'));
  if (b._audRunning) return auditionCancel(b);
  saveVoiceSettings(/** @type {HTMLSelectElement} */ ($('pgVoice')).value, curParams(PG_F), PG_F.ctx);
  runAudition(/** @type {HTMLSelectElement} */ ($('pgVoice')).value, curParams(PG_F), b, /** @type {VEl} */ ($('pgAudOut')));
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE TWO CLUSTER WIRINGS BELOW ARRIVED AT 7.3-m4t, OUT OF THE MIDDLE OF THE NOMI BANNER.
//
// `wireAudCluster` and `wireClearCache` were declared inside `── Nomi voice map (admin tab →
// GET/PUT /nomi) ──` and are not Nomi code: they are the generic "wire an audition cluster" and
// "wire its 🧹 Clear cached button" for ANY entity row, and the SillyTavern tab calls both
// (index.html's `wireClearCache(pre,selId,()=>stLast.def)` and `wireAudCluster('stDef',…)`).
// `wireNomiCluster` — the three-line arrow that binds them to the Nomi option list — stayed in the
// page, because THAT one is Nomi's.
//
// 📌 EXACTLY THE m4o MOVE, AND FOR THE SAME REASON. There the ★ came out of the swap-library
// banner before the library could be extracted; here these come out before `st/nomi.js` can be.
// Leave them and `st/nomi.js` exports a pair of generic wiring helpers that the SillyTavern tab
// has to import from a sibling FEATURE — and the next extraction inherits the same knot one file
// further on. **A helper with callers in two features belongs to neither of them.**
//
// 📌 AND THEY CAME HERE RATHER THAN TO A NEW `ui/audcluster.js`. Everything `wireAudCluster` does
// is built from this file — `updateAudition`, `runAudition`, `AUDITION_TEXT` — so a separate module
// would be one `ui/` file importing another for the same concern, and §4's line for this file
// ("runAudition, updateAudition, hideAudio, curParams") already describes the cluster they wire.
//
// ⚠️ TWO INLINE GLOBALS ARE REACHED AT CALL TIME, and both are scheduled:
//
//   curParams    inline by design — see the note at the top of this file, it is NOT moving here
//   loadPgLib    Playground; becomes an import at pg/*
//
// ✅ IT WAS FOUR UNTIL 7.3-m4u, AND THE OTHER TWO WERE THE INTERESTING ONES. `wireClearCache` used
// to render the voice's LABEL from `stVoiceOpts.length ? stVoiceOpts : nomiOpts` — a shared `ui/`
// helper reaching into TWO sibling features' state to answer a question **both of its callers
// already knew the answer to**. The cost was not the reach itself; it was that both names then had
// to stay declared in index.html forever, because making either one module-private turned the other
// feature's 🧹 Clear cached button into a ReferenceError. m11a's header spends a paragraph on that
// constraint and m4t's pointer spends another.
//
// The list is a PARAMETER now (`optsOf`), threaded from the four call sites that always had it in
// hand. Both reaches are gone, the constraint on both names is gone, and `st/nomi.js` took
// `nomiOpts` private in the same commit. 📌 **A "this must stay inline forever" note is worth one
// look at WHY the helper needs the global — twice now the answer has been that it never did.**
// Generic cluster wiring for the entity tabs (Nomi mapping rows, Nomi default,
// SillyTavern default): the knobs hold on-screen values only — ▶ Audition
// renders them via the shared clip flow and persists NOTHING (per-entity
// settings save via each tab's Save button; the default clusters' knobs are
// audition-only). A voice change deliberately does NOT reload the knobs:
// settings belong to the entity, not the voice.
// 🔴 `optsOf` IS A THUNK, NOT AN ARRAY, AND THAT IS NOT STYLE (7.3-m4u). It is read at CLICK time,
// inside the Clear-cached handler, which is when the old code read the global it replaced.
// `nomiOpts` is REASSIGNED by `pollNomiNew` without re-wiring the rows already on screen, so a
// captured array reference would go stale on any row wired before a poll — and the symptom would be
// a confirm dialog naming the wrong voice while deleting the right one's cache. Pass `()=>list`.
/**
 * @param {string} pre
 * @param {string} voice
 * @param {(voice: string) => string} optionsHtml — builds this cluster's `<option>` list.
 * @param {(() => string) | null} clearFallback — the 🧹 Clear default-voice fallback; `null` for
 *   entity rows, which always have a voice of their own.
 * @param {() => VoiceRow[]} optsOf — 🔴 A THUNK, read at click time — see the header.
 * @param {(() => CacheSpeaker) | null} [speakerOf] - a CHARACTER row's own cache (11.3.0); see
 *   `wireClearCache`. Omitted for the default-voice clusters, which count and clear by voice.
 */
export function wireAudCluster(pre, voice, optionsHtml, clearFallback, optsOf, speakerOf) {
  const f = { exag: pre + 'Exag', cfg: pre + 'Cfg', temp: pre + 'Temp' },
    selId = pre + 'Voice';
  /** @type {VEl} */ ($(selId)).innerHTML = optionsHtml(voice);
  /** @param {boolean} [play] */
  const upd = play => updateAudition(f, selId, pre + 'AudOut', play);
  /** @type {VEl} */ ($(selId)).addEventListener('change', () => upd(true));
  /** @type {VEl} */ ($(pre + 'Prev')).onclick = () => stepVoice(selId, -1);
  /** @type {VEl} */ ($(pre + 'Next')).onclick = () => stepVoice(selId, 1);
  for (const k of /** @type {(keyof DeliveryFields)[]} */ (['exag', 'cfg', 'temp'])) {
    /** @type {VEl} */ ($(f[k])).addEventListener('input', () => upd());
    /** @type {VEl} */ ($(f[k])).addEventListener('change', () => upd());
  }
  /** @type {VEl} */ ($(pre + 'Aud')).onclick = () =>
    runAudition(
      /** @type {HTMLSelectElement} */ ($(selId)).value,
      curParams(f),
      /** @type {AuditionBtn} */ ($(pre + 'Aud')),
      /** @type {VEl} */ ($(pre + 'AudOut')),
    );
  wireClearCache(pre, selId, clearFallback, optsOf, speakerOf);
  upd();
}
/**
 * One character's cache, as a row names it: `kind` + the settings `key` it is saved under (the
 * ST registry key, or the Nomi ID), and the `label` the confirm shows.
 * @typedef {{kind: 'st'|'nomi', key: string, label: string}} CacheSpeaker
 */
/**
 * @param {string} pre
 * @param {string} selId
 * @param {(() => string) | null} [fallback]
 * @param {(() => VoiceRow[]) | null} [optsOf]
 * @param {(() => CacheSpeaker) | null} [speakerOf] - 11.3.0. Given, the field and the button are
 *   about THIS character only. A thunk because the Nomi row's ID is an editable input.
 */
export function wireClearCache(pre, selId, fallback, optsOf, speakerOf) {
  const cb = /** @type {HTMLButtonElement} */ ($(pre + 'Clear'));
  if (!cb) return;
  // 11.2.9 — the "Cached messages" field beside the button. Keyed by `pre` so a re-render of the
  // same row replaces its entry rather than piling up; entries whose field has left the page are
  // dropped at the next paint.
  cacheFields.set(pre, {
    field: pre + 'ClearStats',
    voice: () => /** @type {HTMLSelectElement} */ ($(selId)).value || (fallback ? fallback() : ''),
    speaker: speakerOf || null,
  });
  if (speakerOf) {
    const fld = $(pre + 'ClearStats');
    if (fld) fld.title = "This character's cached messages, and the disk space they use.";
    cb.title =
      "Delete this character's cached messages — they render fresh the next time they play. Other characters on the same voice keep theirs.";
    cb.onclick = async () => {
      if (await clearSpeakerCache(speakerOf(), cb))
        updateAudition({ exag: pre + 'Exag', cfg: pre + 'Cfg', temp: pre + 'Temp' }, selId, pre + 'AudOut');
    };
    loadCacheStatsSoon();
    return;
  }
  /** @type {VEl} */ ($(selId)).addEventListener('change', () => paintCacheField(pre));
  loadCacheStatsSoon();
  cb.onclick = async () => {
    // Clear = bump the voice file's mtime server-side: every cached message
    // rendered with that voice re-keys, so the next play re-renders fresh.
    const v = /** @type {HTMLSelectElement} */ ($(selId)).value || (fallback ? fallback() : '');
    if (!v) {
      await modal('No voice selected', 'Pick a voice (or set a default voice) first — the cache is cleared per voice file.', [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
      return;
    }
    if (await clearVoiceCache(v, voiceLabelOf(optsOf ? optsOf() : [], v), cb))
      updateAudition({ exag: pre + 'Exag', cfg: pre + 'Cfg', temp: pre + 'Temp' }, selId, pre + 'AudOut'); // hide the player if its clip died
  };
}
/**
 * Confirm, then clear one voice's cached messages. Returns true when it cleared. 11.3.0 — split
 * out of `wireClearCache` so the SillyTavern tab's voice cache table runs the SAME confirm and the
 * same request as the button inside each row; two copies of a delete are two places for the
 * confirm text or the audition sweep to drift.
 * @param {string} v - the voice filename
 * @param {string} label - what the confirm calls it
 * @param {HTMLButtonElement} btn - disabled while it runs, and says "Cleared ✓" after
 * @returns {Promise<boolean>}
 */
export async function clearVoiceCache(v, label, btn) {
  const s = cacheStats && cacheStats[v];
  const what = s && s.messages ? ` — <b>${s.messages.toLocaleString()}</b> cached message(s), ${fmtCacheBytes(s.bytes)} —` : '';
  if (
    !(await modal(
      'Clear cached renders',
      `Every Nomi and SillyTavern message rendered with <b>${esc(label)}</b>${what} will re-render fresh (current settings, new take) the next time it plays. Cached audio for this voice is gone for good.`,
      [
        { label: 'Cancel', value: 0 },
        { label: '🧹 Clear cached', class: 'danger', value: 1 },
      ],
    ))
  )
    return false;
  btn.disabled = true;
  const lbl = btn.textContent;
  try {
    // Clear = bump the voice file's mtime (every cached message rendered with it re-keys) AND,
    // since 11.2.9, delete the cached files of every speaker on the voice.
    const r = await fetch('/voices/' + encodeURIComponent(v) + '/clear_cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audition_text: AUDITION_TEXT }),
    }); // sweep audition previews too
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    await loadCacheStats(); // every field on screen: other rows may share this voice
    await pgLibLoad(); // re-read the clip list from disk
    btn.textContent = 'Cleared ✓';
    setTimeout(() => {
      btn.textContent = lbl;
    }, 1200);
    return true;
  } catch (e) {
    await modal('Clear failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    return false;
  } finally {
    btn.disabled = false;
  }
}

/**
 * Confirm, then delete ONE character's cached messages (11.3.0). No voice mtime bump, and no
 * audition sweep: both belong to the voice, and every other speaker on it keeps its cache.
 * @param {CacheSpeaker} sp
 * @param {HTMLButtonElement} btn
 * @returns {Promise<boolean>}
 */
async function clearSpeakerCache(sp, btn) {
  const s = cacheSpeakers && cacheSpeakers[sp.kind] && cacheSpeakers[sp.kind][sp.key];
  const what =
    s && s.messages ? `<b>${s.messages.toLocaleString()}</b> cached message(s), ${fmtCacheBytes(s.bytes)}` : 'the cached messages';
  if (
    !(await modal(
      'Clear cached messages',
      `Delete ${what} for <b>${esc(sp.label || sp.key)}</b>? They re-render fresh (current settings, new take) the next time they play. Other characters on the same voice keep theirs.`,
      [
        { label: 'Cancel', value: 0 },
        { label: '🧹 Clear cached', class: 'danger', value: 1 },
      ],
    ))
  )
    return false;
  btn.disabled = true;
  const lbl = btn.textContent;
  try {
    await jpost('/voices/cache/clear_speaker', { kind: sp.kind, key: sp.key });
    await loadCacheStats(); // the voice totals in the table move too
    btn.textContent = 'Cleared ✓';
    setTimeout(() => {
      btn.textContent = lbl;
    }, 1200);
    return true;
  } catch (e) {
    await modal('Clear failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    return false;
  } finally {
    btn.disabled = false;
  }
}

// ── the "Cached messages" field (11.2.9) ─────────────────────────────────────────────────────
// Each Clear button has a read-only field before it: how many Nomi/SillyTavern messages are
// cached for the voice that button would clear, and their size. The server answers for EVERY
// voice in one request (/voices/cache_stats) — a SillyTavern tab can hold dozens of rows and a
// per-row fetch would stat the same cache dozens of times.
//
// 📌 WHEN IT REFRESHES: when rows are wired (debounced, so a whole tab render is one request),
// after a Clear, when the row's voice changes (a repaint from what is already loaded), and every
// 30 s while a field is on screen — messages keep caching while the tab sits open, and the tabs'
// own 4 s pollers are too frequent for a walk of the whole cache.
/** @type {Map<string, {field: string, voice: () => string, speaker: (() => CacheSpeaker) | null}>} */
const cacheFields = new Map();
/** @type {Record<string, {messages: number, bytes: number}> | null} */
let cacheStats = null;
/** 11.3.0 — per character: `{st: {<registry key>: …}, nomi: {<Nomi ID>: …}}`, same fetch.
 * @type {Record<string, Record<string, {messages: number, bytes: number}>> | null} */
let cacheSpeakers = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let cacheStatsTimer = null;
const CACHE_STATS_EVERY_MS = 30000;

/** @param {number} b */
export function fmtCacheBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}
/** @param {string} pre */
function paintCacheField(pre) {
  const ent = cacheFields.get(pre);
  if (!ent) return;
  const el = /** @type {HTMLInputElement|null} */ ($(ent.field));
  if (!el) {
    cacheFields.delete(pre); // its row has left the page
    return;
  }
  /** @type {{messages: number, bytes: number} | null} */
  let s;
  if (ent.speaker) {
    // A character row counts its own folder, whatever voice the dropdown shows. A row not saved
    // yet has no folder: zero, not "—", because zero is the true answer.
    const sp = ent.speaker();
    s = cacheSpeakers ? (cacheSpeakers[sp.kind] || {})[sp.key] || { messages: 0, bytes: 0 } : null;
  } else {
    const v = ent.voice();
    s = cacheStats && v ? cacheStats[v] || { messages: 0, bytes: 0 } : null; // null: not loaded, or no voice
  }
  el.value = s ? `${s.messages.toLocaleString()} msgs · ${fmtCacheBytes(s.bytes)}` : '—';
}
/** Fetch the counts for every voice and repaint every field on the page. */
export async function loadCacheStats() {
  try {
    const j = await jget('/voices/cache_stats');
    cacheStats = j.voices || {};
    cacheSpeakers = j.speakers || {};
  } catch (e) {
    // A locked vault or a dropped connection: keep the last numbers (or "—") rather than
    // blanking every field. The next refresh tries again.
    console.warn('cache stats: fetch failed', e);
  }
  for (const pre of [...cacheFields.keys()]) paintCacheField(pre);
  for (const fn of cacheListeners) fn(cacheStats);
}
/** @type {((s: Record<string, {messages: number, bytes: number}> | null) => void)[]} */
const cacheListeners = [];
/**
 * 11.3.0 — the SillyTavern tab's voice cache table repaints from the same fetch as the fields,
 * rather than asking the server again on its own schedule.
 * @param {(s: Record<string, {messages: number, bytes: number}> | null) => void} fn
 */
export function onCacheStats(fn) {
  cacheListeners.push(fn);
}
/**
 * One character's cached messages from the last fetch, or null before the first one lands.
 * 11.3.2 — the collapsed SillyTavern rows show it in their header.
 * @param {'st'|'nomi'} kind
 * @param {string} key
 * @returns {{messages: number, bytes: number} | null}
 */
export function speakerCacheStats(kind, key) {
  if (!cacheSpeakers) return null;
  return (cacheSpeakers[kind] || {})[key] || { messages: 0, bytes: 0 };
}
/** Coalesce the per-row calls of one tab render into a single fetch. */
export function loadCacheStatsSoon() {
  if (cacheStatsTimer) clearTimeout(cacheStatsTimer);
  cacheStatsTimer = setTimeout(() => {
    cacheStatsTimer = null;
    loadCacheStats();
  }, 50);
}
setInterval(() => {
  if (document.hidden) return;
  // offsetParent is null for anything inside a hidden tab or a collapsed row — no fetch for a
  // number nobody can see. `.cacheStats` marks the fields AND the SillyTavern tab's cache table.
  const visible = [...document.querySelectorAll('.cacheStats')].some(el => /** @type {HTMLElement} */ (el).offsetParent !== null);
  if (visible) loadCacheStats();
}, CACHE_STATS_EVERY_MS);
