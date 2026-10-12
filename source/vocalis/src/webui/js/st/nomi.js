// st/nomi.js — the ⚙ Settings ▸ Nomi tab: map each Nomi to a voice and its own delivery settings
// (7.3-m11a, opening §5's m11).
//
// 108 lines out of `── Nomi voice map (admin tab → GET/PUT /nomi) ──`, one contiguous cut. Each
// mapping row is the same `voiceClusterHTML` the Book and Playground tabs render; the knobs are
// that Nomi's OWN entry in the `nomi` section of voice_settings.yaml, which is exactly what /speak
// reads. ▶ Audition renders the on-screen values and persists nothing — only Save does.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — two names, and both exist for one caller apiece: the tab switch.
//
//   loadNomi       `switchTab`'s `if(name==='nomi')` case, plus ↻ Refresh (wired below) and the
//                  Save handler's tail
//   nomiPollStop   `switchTab`'s `if(name!=='nomi')` case — LEAVING the tab is what stops the live
//                  card poll, and nothing else can do it
//
// 🔴 THEY ARE A PAIR AND THE SECOND ONE IS THE EASY ONE TO LOSE. `nomiPollStart` runs a 4-second
// `GET /nomi` for as long as the tab is open; drop `nomiPollStop` from the shim and it polls
// forever, invisibly, on every tab the user visits afterward. Same shape as `st/log.js`'s two
// exports (m4k), and the reason that file's header says the same thing.
//
// ⚠️ TWELVE NAMES STAY PRIVATE, including every renderer. The measured leak count into the rest of
// the page was exactly two — the pair above.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ `nomiOpts` IS PRIVATE TO THIS FILE (7.3-m4u). THIS BLOCK USED TO SAY THE OPPOSITE.
//
// For exactly one commit it was declared in index.html and assigned from here, because
// `js/ui/audition.js`'s `wireClearCache` rendered its confirm-dialog label from
// `stVoiceOpts.length ? stVoiceOpts : nomiOpts` — one generic helper reading BOTH features'
// option lists, so a `nomiOpts` that went private here was a ReferenceError the first time anyone
// clicked 🧹 Clear cached on a SillyTavern row. This header argued the constraint was structural:
// exporting it instead would point `ui/` at `st/`, which is the knot m4t had just undone.
//
// 🔴 IT WAS NEITHER. m4u asked the question neither this header nor m4t's pointer had —  *why does
// the helper want the global at all?* — and the answer was that all four call sites already had
// the list. It is a parameter now (`optsOf`, ⚠️ a THUNK, read at click time, because
// `pollNomiNew` reassigns this array without re-wiring rows already on screen). `stVoiceOpts` went
// private with js/st/chars.js at m11b. Neither name is declared in index.html any more. §11.14.
//
// ⚠️ `nomiDefVoice` DOES come — every read and both writes were inside the range, so it is a
// private `let` here and there is nothing left in the page to fork against.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ `loadNomi` LEAVES `_PARSE_TIME_SURFACE` — the SIXTH name to, and the fourth without an arrow.
// `$('nomiRefresh').onclick=loadNomi` was inside the moved range and traveled with the function.
//
// ⚠️ THREE INLINE GLOBALS ARE STILL REACHED AT CALL TIME, all of them safe (§3.1) and all of them
// scheduled: `clusterIds` and `voiceClusterHTML` (§4 files both under `ui/voicepicker.js`, and
// 🔴 NEITHER IS THERE YET — m4q took `voiceOptionsHTML`/`useDefaultLabel` and left these two; see
// §11.12, which is about importing a name because the plan said it would be there), and
// `loadPgLib`, which becomes an import at `pg/*`.

import { $, esc } from '../util/dom.js';
import { jget } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { voiceOptionsHTML, useDefaultLabel, UNSET_DEFAULT_LABEL, voiceClusterHTML, clusterIds } from '../ui/voicepicker.js'; // 7.3-m12c: last two were inline globals
import { updateAudition, wireAudCluster } from '../ui/audition.js';
import { pgLibLoad } from '../pg/pgstate.js'; // 7.5.6 — was `loadPgLib` from playground.js

// Each mapping row renders the SAME voiceClusterHTML as Book/Playground. The
// knobs are the NOMI's OWN delivery settings (its entry in the `nomi` section
// of voice_settings.yaml — exactly what /speak uses; a missing value is the
// chatterbox default). ▶ Audition renders the on-screen values via the shared
// clip flow and persists NOTHING; only Save does (PUT /nomi, full map).
let nomiDefVoice = ''; // set by loadNomi; row dropdowns show it
// ✅ PRIVATE AS OF 7.3-m4u. It was declared in index.html at m11a so ui/audition.js's
// `wireClearCache` could reach it; that helper takes the list as a parameter now, and this
// module is its only reader and its only two writers (loadNomi, pollNomiNew).
/** @type {VoiceRow[]} */
let nomiOpts = [];
/** @param {string} [sel] */
const nomiVoiceSelect = sel => voiceOptionsHTML(nomiOpts, sel, useDefaultLabel(nomiOpts, nomiDefVoice));
/**
 * A `.nomirow` element. `nomiRow` writes `data-pre` on every row it builds, so it is `string`
 * here and not `string|undefined`.
 * @typedef {HTMLElement & { dataset: { pre: string } }} NomiRowEl
 */
/** @param {string} pre */
const nomiF = pre => ({ exag: pre + 'Exag', cfg: pre + 'Cfg', temp: pre + 'Temp' });
let nomiSeq = 0; // per-row id prefixes survive add/remove churn
/**
 * @param {string} id
 * @param {string} name
 * @param {boolean} narrate
 */
function nomiRow(id, name, narrate) {
  const pre = `nm${nomiSeq++}`;
  return `<div class="nomirow" data-pre="${pre}" style="border-top:1px solid rgba(128,128,128,.25);padding-top:10px;margin-top:10px">
    <div class="row" style="align-items:flex-end;gap:8px">
      <div style="flex:0 0 130px"><label>Nomi ID</label><input class="nid" value="${esc(id)}" placeholder="e.g. 1382658411"></div>
      <div style="flex:1"><label>Name</label><input class="nname" value="${esc(name)}"></div>
      <div style="flex:0 0 auto"><label title="Speak roleplay text wrapped in asterisks for THIS Nomi. Off = only the dialogue outside *…* is spoken.">Narrate *actions*</label><input type="checkbox" class="nnarrate"${narrate !== false ? ' checked' : ''}></div>
      <div style="flex:0"><button class="sm nremove" title="Remove this Nomi">✕</button></div>
    </div>
    ${voiceClusterHTML(clusterIds(pre))}
  </div>`;
}
// ⚠️ `wireAudCluster` IS AN IMPORT, NOT A LOCAL. It and `wireClearCache` were declared inside this
// area's banner and came out at m4t, one commit before this one, because the SillyTavern tab calls
// both — generic entity-row wiring belongs to neither feature that uses it (the m4o rule). The
// three-line arrow below is the only Nomi-specific part of that pairing, and it stayed with Nomi.
/**
 * @param {string} pre
 * @param {string} voice
 * @param {HTMLElement} row — 11.3.0: the row's own cache is keyed by its Nomi ID, read live
 *   because the ID is an editable field.
 */
const wireNomiCluster = (pre, voice, row) =>
  wireAudCluster(
    pre,
    voice,
    nomiVoiceSelect,
    () => nomiDefVoice,
    () => nomiOpts,
    () => ({
      kind: 'nomi',
      key: /** @type {HTMLInputElement} */ (row.querySelector('.nid')).value.trim(),
      label: /** @type {HTMLInputElement} */ (row.querySelector('.nname')).value.trim(),
    }),
  );
const NOMI_EMPTY_HTML =
  '<span class="muted">No Nomis yet — play one in the Nomi extension and its card appears here automatically (name filled in), or use “+ Add Nomi”.</span>';
/**
 * One Nomi's entry in the `nomi` section of voice_settings.yaml — `/nomi`'s `nomis[id]`, and
 * what ▶ Save PUTs back.
 * @typedef {object} NomiEntry
 * @property {string} [name]
 * @property {string} [voice]
 * @property {number} [exaggeration]
 * @property {number} [cfg]
 * @property {number} [temperature]
 * @property {boolean} [narrate_actions]
 */
// One mapping row appended to #nomiList and wired like the rest. Shared by loadNomi
// (initial render), + Add Nomi (an empty row), and the live poll (a card the
// extension just auto-created) so all three build identical rows.
/**
 * @param {string} id
 * @param {NomiEntry} [e]
 */
function appendNomiRow(id, e) {
  e = e || {};
  const list = /** @type {VEl} */ ($('nomiList')),
    m = list.querySelector('.muted');
  if (m) list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', nomiRow(id, e.name || '', e.narrate_actions !== false));
  const rows = /** @type {NodeListOf<NomiRowEl>} */ (list.querySelectorAll('.nomirow')),
    r = rows[rows.length - 1],
    f = nomiF(r.dataset.pre);
  // `String(...)`: an input's `.value` is a string; the runtime was already coercing this
  // (same note as `ui/theme.js`'s `uiFontApply`).
  /** @type {HTMLInputElement} */ ($(f.exag)).value = String(e.exaggeration != null ? e.exaggeration : 0.5); // the NOMI's own params
  /** @type {HTMLInputElement} */ ($(f.cfg)).value = String(e.cfg != null ? e.cfg : 0.5);
  /** @type {HTMLInputElement} */ ($(f.temp)).value = String(e.temperature != null ? e.temperature : 0.8);
  wireNomiCluster(r.dataset.pre, e.voice || '', r);
  return r;
}
export async function loadNomi() {
  try {
    const c = await jget('/nomi');
    nomiOpts = c.voice_options || [];
    nomiDefVoice = c.default_voice || '';
    // default-voice cluster (same component; knobs audition-only — unmapped
    // Nomis speak this voice at the chatterbox defaults)
    /** @type {VEl} */ ($('nomiDefaultCluster')).innerHTML = voiceClusterHTML(clusterIds('nmDef'));
    wireAudCluster(
      'nmDef',
      nomiDefVoice,
      sel => voiceOptionsHTML(nomiOpts, sel, UNSET_DEFAULT_LABEL),
      null,
      () => nomiOpts,
    );
    const nomis = c.nomis || {},
      ids = Object.keys(nomis);
    nomiSeq = 0;
    /** @type {VEl} */ ($('nomiList')).innerHTML = ids.length ? '' : NOMI_EMPTY_HTML;
    ids.forEach(id => appendNomiRow(id, nomis[id]));
    pgLibLoad().then(() => {
      // ALWAYS re-read the clip list from disk on tab open —
      // cached-audition players must reflect deletions made elsewhere
      /** @type {NodeListOf<NomiRowEl>} */ (document.querySelectorAll('#nomiList .nomirow')).forEach(r => {
        const f = nomiF(r.dataset.pre);
        updateAudition(f, r.dataset.pre + 'Voice', r.dataset.pre + 'AudOut');
      });
    });
    nomiPollStart(); // live-append cards the extension auto-creates while this tab is open
  } catch (e) {
    /** @type {VEl} */ ($('nomiList')).innerHTML = `<span class="drop">${esc(/** @type {ErrLike} */ (e).message)}</span>`;
  }
}
// Live refresh without a page reload: the extension auto-creates a card server-side
// the first time you play a new Nomi; this polls GET /nomi and APPENDS any card not
// already on screen. Append-only on purpose — it never re-renders or reorders an
// existing row, so an unsaved edit in a row you're working on is never clobbered.
/** @type {ReturnType<typeof setInterval>|null} */
let nomiPollTimer = null;
async function pollNomiNew() {
  if (document.hidden) return;
  let c;
  try {
    c = await jget('/nomi');
  } catch (e) {
    return;
  } // silent; ↻ and tab-open surface errors
  nomiOpts = c.voice_options || nomiOpts; // keep newly-added voices selectable
  nomiDefVoice = c.default_voice || nomiDefVoice;
  const nomis = c.nomis || {},
    have = new Set(
      [.../** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('#nomiList .nomirow .nid'))].map(i => i.value.trim()),
    );
  Object.keys(nomis).forEach(id => {
    if (id && !have.has(id)) appendNomiRow(id, nomis[id]);
  });
}
function nomiPollStart() {
  nomiPollStop();
  nomiPollTimer = setInterval(pollNomiNew, 4000);
}
export function nomiPollStop() {
  if (nomiPollTimer) {
    clearInterval(nomiPollTimer);
    nomiPollTimer = null;
  }
}
// Switching back to this browser tab -> refresh immediately instead of waiting the interval out.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && nomiPollTimer) pollNomiNew();
});
/** @type {VEl} */ ($('nomiRefresh')).onclick = loadNomi;
/** @type {VEl} */ ($('nomiAdd')).onclick = () => appendNomiRow('', {});
/** @type {VEl} */ ($('nomiList')).addEventListener('click', async e => {
  const b = /** @type {HTMLElement} */ (e.target).closest('.nremove');
  if (!b) return;
  const row = /** @type {HTMLElement} */ (b.closest('.nomirow')),
    nmEl = /** @type {HTMLInputElement} */ (row.querySelector('.nname')),
    idEl = /** @type {HTMLInputElement} */ (row.querySelector('.nid')),
    nm = (nmEl.value || '').trim(),
    id = (idEl.value || '').trim();
  if (
    (nm || id) &&
    !(await modal('Remove Nomi', `Remove <b>${esc(nm || id)}</b> from the list? (Applied when you click Save.)`, [
      { label: 'Cancel', value: 0 },
      { label: 'Remove', class: 'danger', value: 1 },
    ]))
  )
    return;
  row.remove();
});
/** @type {VEl} */ ($('nomiSave')).onclick = async e => {
  /** @type {Record<string, NomiEntry>} */
  const nomis = {};
  /** @type {string|null} */
  let bad = null;
  /** @type {NodeListOf<NomiRowEl>} */ (document.querySelectorAll('#nomiList .nomirow')).forEach(r => {
    const id = /** @type {HTMLInputElement} */ (r.querySelector('.nid')).value.trim();
    if (!id) {
      bad = bad || 'Every Nomi needs an ID.';
      return;
    }
    if (nomis[id]) bad = bad || `Duplicate Nomi ID “${id}”.`;
    const f = nomiF(r.dataset.pre);
    nomis[id] = {
      name: /** @type {HTMLInputElement} */ (r.querySelector('.nname')).value.trim(),
      voice: /** @type {HTMLSelectElement} */ ($(r.dataset.pre + 'Voice')).value,
      exaggeration: +(/** @type {HTMLInputElement} */ ($(f.exag)).value),
      cfg: +(/** @type {HTMLInputElement} */ ($(f.cfg)).value),
      temperature: +(/** @type {HTMLInputElement} */ ($(f.temp)).value),
      narrate_actions: /** @type {HTMLInputElement} */ (r.querySelector('.nnarrate')).checked,
    };
  });
  if (bad) {
    await modal('Cannot save', esc(bad), [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  const btn = /** @type {HTMLButtonElement} */ (e.target);
  btn.disabled = true;
  try {
    const r = await fetch('/nomi', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nomis, default_voice: $('nmDefVoice') ? /** @type {HTMLSelectElement} */ ($('nmDefVoice')).value : '' }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    btn.textContent = 'Saved ✓';
    setTimeout(() => (btn.textContent = 'Save'), 1200);
    loadNomi();
  } catch (err) {
    await modal('Save failed', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    btn.disabled = false;
  }
};
