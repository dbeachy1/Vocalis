// ui/voicepicker.js — one voice ordering and one <option> vocabulary, for every dropdown in the
// app (7.3-m4q). §4 named this file at the start of the milestone; this is it.
//
// Moved verbatim from index.html's `── Voice pickers: two alphabetical blocks, favorites then the
// rest (4.8-m5 §16.9) ──` banner: 41 lines, eight definitions, ZERO top-level statements. The two
// `$('…Cluster').innerHTML=voiceClusterHTML(…)` lines that sat at the end of that banner STAYED IN
// THE PAGE — they belong to `voiceClusterHTML`, which is declared above the banner and is one of
// §3.1's deliberate duplications, so they were never picker code (the m3e shape: a range whose tail
// belongs to something else).
//
// 🔴 THIS CUT WAS UNBLOCKED BY m4o, AND THE PAGE SAID SO ITSELF. `voiceOrder` calls `favFirst`, and
// the comment above it used to read: *"⚠ favFirst is declared much further down (the Voice Swap
// block). That is fine because every caller of voiceOrder runs after script evaluation — but it
// means voiceOptionsHTML must never be invoked at module level, or this is a temporal-dead-zone
// ReferenceError."* That hazard is GONE, not merely documented: `favFirst` is an import now, and an
// import is resolved before this module's body runs. Calling `voiceOptionsHTML` at module level is
// safe here in a way it could never be in the page. The warning is kept below as history, marked.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — seven of the eight, and they split into two very different groups.
//
//   FOUR WITH INLINE CALLERS, all in the Nomi and SillyTavern voice maps, which move in m11:
//     voiceOptionsHTML     4 sites — every character/default dropdown either tab builds
//     useDefaultLabel      2 — the "(use default voice — Aria)" empty option
//     UNSET_DEFAULT_LABEL  2 — its counterpart for a DEFAULT dropdown, where there is no fallback
//     voiceLabelOf         1 — the re-render confirm, which names the voice rather than the file
//   ONE WITH AN INLINE CALLER IN THE VOICES TAB (m8): byVoiceName, `vSort==='name'?byVoiceName:…`
//   TWO WITH NO INLINE CALLER AT ALL — voiceOrder and voiceOptText. See below; they are the
//   interesting ones.
//
// ✅ AND IT CLOSES AN INLINE-GLOBAL REACH RATHER THAN OPENING ONE. js/sys/devices.js has been
// reaching THROUGH THE GLOBAL SCOPE for `voiceOrder` and `voiceOptText` since 7.3-m4a — its header
// listed them among six such names — because they were inline and there was nowhere to import them
// from. There is now, and it imports them. That is the `fmtEta` move again (7.3-m4): the point of
// a shared module is not that the code sits somewhere tidier, it is that its consumers stop
// guessing. devices.js is down to four inline reaches.
//
// 📌 `voiceSortName` IS THE ONLY PRIVATE ONE, and only because `byVoiceName` is its sole caller.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// IT REACHES FOR NO INLINE GLOBAL. NONE. That is the first time in 7.3 and it is why this area
// ranked where it did — `esc` and `favFirst` are both imports, and there is nothing else. Which
// also means this module is the first that could be unit-tested with no page at all.
//
// 📌 NOTHING WIRES AT MODULE LOAD either — eight pure definitions, no listener, no DOM read. Along
// with ui/fav.js, one of exactly two modules for which the export list is the whole story.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THAT LAST PARAGRAPH STOPPED BEING TRUE AT 7.3-m12c, AND THE CHANGE IS THE POINT OF THE COMMIT.
// `TIP`, `voiceClusterHTML` and `clusterIds` arrived from index.html, and so did the two
// `$('…Cluster').innerHTML=` statements that PAINT the Book and Playground clusters. This module
// now writes DOM at module-eval, and it is the earliest thing in the graph that has to.
//
// **`voiceClusterHTML` was §3.2 failure shape 1 — it paints markup that other code then queries.**
// While it was inline it painted during parsing, so every `$('voice')`, `$('pgExag')`,
// `$('pgActions')` below it was addressing elements that already existed. `_PARSE_TIME_SURFACE`
// recorded exactly that and named this file as the target.
//
// 🔴 SO THE ONE THING THAT MATTERS HERE IS EVALUATION ORDER, and it is enforced by IMPORTS rather
// than by position in index.html's shim. Three module bodies wire ids this file paints:
//
//   js/pg/playground.js   #voicePrev #voiceNext #pgVoicePrev #pgVoiceNext #pgActions
//   js/ui/audition.js     #audBtn #pgAudBtn, and the two per-voice `change` listeners
//   js/main.js            #refreshVoices #pgRefresh
//
// The first two already `import` from this file (`stepVoice`, m6d), so ES module evaluation order
// puts this body first by construction — not by luck and not by where the shim lists it. **Keep it
// that way**: an importer that stops needing a NAME from here still needs the ORDER, which is what
// `js/main.js`'s explicit import at the bottom of its list is for. main.js is additionally safe
// because the shim reaches it through a *dynamic* `await import()` that runs after every static
// one (§11.3) — but depending on that alone is depending on one line of index.html.
//
// ⚠️ AND THE PAINT MUST STAY AT MODULE LEVEL, not inside an exported `paintClusters()` that someone
// calls from boot. Boot is eight network round trips away; the three modules above wire at their
// own module-eval, long before it. That would be the same "gate opens before the thing exists"
// shape as §11.6 item 3, with no error to say so — just five silently dead controls.

import { $, esc } from '../util/dom.js';
import { favFirst } from './fav.js';

// ── the ONE voice-controls cluster (Book, Playground, Nomi, and SillyTavern
//    all render the same component) ──────────────────────────────────────────
const TIP = {
  exag: 'Emotional intensity of the delivery. 0.5 = neutral; higher = more dramatic and expressive (too high turns theatrical or unstable); lower = flatter and calmer.',
  cfg: 'Guidance strength — doubles as a pace control. Lower = slower, more deliberate reading; higher = tighter and faster. 0.5 is a good default.',
  temp: 'Sampling adventurousness — how much takes vary. Lower = safer, more consistent delivery; higher = livelier but riskier. 0.8 is a good default.',
};
/**
 * The id map `voiceClusterHTML` paints from and every caller wires against. `clusterIds(pre)`
 * builds the prefixed common case; the two module-level paints below add `refresh`/`extra` by
 * hand for the one-off Book/Playground clusters.
 * @typedef {object} ClusterIds
 * @property {string} voice
 * @property {string} prev
 * @property {string} next
 * @property {string} aud
 * @property {string} audOut
 * @property {string} exag
 * @property {string} cfg
 * @property {string} temp
 * @property {string} [refresh] - Book/Playground only: the ↻ Rescan button.
 * @property {string} [clear] - the 🧹 Clear cached button and, before it, its "Cached messages"
 *   field (`clear + 'Stats'`, 11.2.9); entity rows only (Nomi/SillyTavern).
 * @property {string} [extra] - pre-rendered HTML appended after the Temp knob; Playground's
 *   "Narrate *actions*" checkbox is the only user of it.
 */
/**
 * @param {ClusterIds} p
 * @returns {string}
 */
export function voiceClusterHTML(p) {
  return `<div class="row">
      <div style="flex:1;min-width:260px"><label>Voice</label><select id="${p.voice}"></select></div>
      <div style="flex:0 0 auto;align-self:flex-end;display:flex;gap:4px">
        <button class="sm" id="${p.prev}" title="Previous voice">◀</button>
        <button class="sm" id="${p.next}" title="Next voice">▶</button>
      </div>
      ${p.refresh ? `<div style="flex:0;align-self:flex-end"><button id="${p.refresh}" title="Rescan voices">↻</button></div>` : ''}
      <div style="flex:0;align-self:flex-end"><button id="${p.aud}" class="primary" title="Render a short preview with the selected voice + current settings, then play it here">▶ Audition</button></div>
      <div style="flex:1;min-width:240px;align-self:flex-end"><audio id="${p.audOut}" controls preload="metadata" style="width:100%;display:none"></audio></div>
    </div>
    <div class="row" style="margin-top:8px">
      <div style="flex:0 0 auto" title="${TIP.exag}"><label>Exaggeration</label><input type="number" id="${p.exag}" value="0.5" step="0.05" min="0" max="2" style="width:90px"></div>
      <div style="flex:0 0 auto" title="${TIP.cfg}"><label>CFG</label><input type="number" id="${p.cfg}" value="0.5" step="0.05" min="0" max="1" style="width:90px"></div>
      <div style="flex:0 0 auto" title="${TIP.temp}"><label>Temp</label><input type="number" id="${p.temp}" value="0.8" step="0.05" min="0" max="2" style="width:90px"></div>
      ${p.extra || ''}
      ${p.clear ? clearGroupHTML(p.clear) : ''}
    </div>`;
}
// 11.2.9 — the 🧹 Clear button moved down to the knob row, behind a separator, with a read-only
// field before it saying what it would clear: how many messages are cached for this voice and how
// much disk they take. The count and clear button sit side by side. `wireClearCache`
// (ui/audition.js) fills the field — it is painted
// empty here and reads "—" until the one /voices/cache_stats request for the page comes back.
/** @param {string} id - the Clear button's id; the field is `id + 'Stats'`. */
function clearGroupHTML(id) {
  return `<div style="flex:0 0 auto;align-self:stretch;border-left:1px solid rgba(128,128,128,.35);margin:0 4px"></div>
      <div style="flex:0 0 auto" title="Nomi and SillyTavern messages cached for this voice, and the disk space they use. Counts every speaker whose saved assignment is this voice, including characters that fall back to the default voice."><label>Cached messages</label><input type="text" id="${id}Stats" class="cacheStats" readonly value="—" tabindex="-1" style="width:200px"></div>
      <div style="flex:0;align-self:flex-end"><button id="${id}" class="sm" style="background:#f5e6a3;border-color:#e3cd77;color:#4a3d0e;font-weight:600;border-radius:999px;white-space:nowrap;padding:6px 16px" title="Delete this voice's cached renders — every Nomi and SillyTavern message rendered with it re-renders fresh (with the current settings, as a new take) the next time it's played">🧹 Clear cached messages</button></div>`;
}
// Shared row helpers: prefix -> the cluster's id map, and one voice-options
// builder (empty-option label + keep-missing-value handling) for every tab.
/**
 * @param {string} pre
 * @returns {ClusterIds}
 */
export const clusterIds = pre => ({
  voice: pre + 'Voice',
  prev: pre + 'Prev',
  next: pre + 'Next',
  aud: pre + 'Aud',
  audOut: pre + 'AudOut',
  exag: pre + 'Exag',
  cfg: pre + 'Cfg',
  temp: pre + 'Temp',
  clear: pre + 'Clear',
});
// 🔴 THE TWO PAINTS. Everything downstream addresses the ids these produce — see the header.
/** @type {VEl} */ ($('bookCluster')).innerHTML = voiceClusterHTML({
  voice: 'voice',
  prev: 'voicePrev',
  next: 'voiceNext',
  refresh: 'refreshVoices',
  aud: 'audBtn',
  audOut: 'audOut',
  exag: 'exag',
  cfg: 'cfg',
  temp: 'temp',
});
/** @type {VEl} */ ($('pgCluster')).innerHTML = voiceClusterHTML({
  voice: 'pgVoice',
  prev: 'pgVoicePrev',
  next: 'pgVoiceNext',
  refresh: 'pgRefresh',
  aud: 'pgAudBtn',
  audOut: 'pgAudOut',
  exag: 'pgExag',
  cfg: 'pgCfg',
  temp: 'pgTemp',
  extra: `<div style="flex:0 0 auto"><label title="Speak roleplay text wrapped in asterisks. Off = only the dialogue outside *…* is narrated. Asterisk characters themselves are never spoken either way.">Narrate *actions*</label><input type="checkbox" id="pgActions" checked></div>`,
});

// ── Voice pickers: two alphabetical blocks, favorites then the rest (4.8-m5 §16.9) ──
// Favorites-first is a property of the voice LIST, not of a tab, so it lives in one place
// that BOTH option builders call — voiceOptionsHTML (Nomi/ST) and loadVoices
// (Book/Playground). Deliberately excluding a tab would need a reason and there isn't one.
// ⚠ Sharing the builder is NOT enough on its own: the two builders are fed by two DIFFERENT
// server payloads (/voices vs the voice_options embedded in /nomi and /st/characters). A flag
// missing from one reads as `undefined` here — no ⭐, and favFirst's stable sort is a no-op —
// so the feature looks shipped on half the tabs and absent on the other half, with no error.
// 🔴 Sorted on what the user SEES, not on the filename the server sorted by (§16.9a): §14.2
// made the label the identity and the filename derived plumbing, so the two strings are free
// to start with different letters — and "alphabetical" can only mean the text on screen.
/** @param {VoiceRow} v */
const voiceSortName = v => v.label || v.name || '';
/**
 * @param {VoiceRow} x
 * @param {VoiceRow} y
 * @returns {number}
 */
export const byVoiceName = (x, y) => voiceSortName(x).localeCompare(voiceSortName(y), undefined, { sensitivity: 'accent' });
// favFirst on top of a name sort, not a hand-rolled two-key comparator: Array.sort is stable,
// so the alphabetical order survives inside both halves and "favorites float" stays ONE
// concept in one place (the ★ vocabulary the other three lists already use).
// ✅ HISTORY, 7.3-m4q. This line used to warn: "⚠ favFirst is declared much further down (the
// Voice Swap block). That is fine because every caller of voiceOrder runs after script
// evaluation — but it means voiceOptionsHTML must never be invoked at module level, or this is
// a temporal-dead-zone ReferenceError (cf. vcTab)." It is an import now (js/ui/fav.js, m4o) and
// imports are resolved before a module body runs, so the restriction no longer holds.
/**
 * @param {VoiceRow[]} list — fed by two DIFFERENT server payloads (`/voices`, and the
 *   `voice_options` embedded in `/nomi` and `/st/characters`) — see the warning above.
 * @returns {VoiceRow[]}
 */
export const voiceOrder = list => favFirst([...list].sort(byVoiceName));
// 🔴 The ⭐ is DECORATION on the option's TEXT — the option's value stays the bare filename
// (§16.9c), which is what every setting, clip, sidecar and Nomi/ST mapping keys on. Writing
// "⭐ Sarah.wav" into voice_settings.yaml would break the mapping silently, and the missing-
// value branch below would then render it as "(missing)".
// Emoji, not CSS (§16.9b): an <option>'s `color` is honored inconsistently across browsers,
// and where it IS honored it tints the WHOLE line — which would make the voice name gold too.
// U+2B50 takes its color from the system emoji font, so it is gold by construction everywhere.
/** @param {VoiceRow} v */
export const voiceOptText = v => (v.favorite ? '⭐ ' : '') + (v.label || v.name);
/**
 * @param {VoiceRow[]} list
 * @param {string} [sel] - the currently-selected filename; `''` selects the empty option.
 * @param {string} [emptyLabel] - the empty `<option>`'s text.
 * @returns {string}
 */
export function voiceOptionsHTML(list, sel, emptyLabel) {
  sel = sel || '';
  let o =
    `<option value="">${esc(emptyLabel)}</option>` +
    voiceOrder(list)
      .map(v => `<option value="${esc(v.name)}"${v.name === sel ? ' selected' : ''}>${esc(voiceOptText(v))}</option>`)
      .join('');
  if (sel && !list.some(v => v.name === sel))
    // keep a value whose file is gone (don't silently drop)
    o += `<option value="${esc(sel)}" selected>${esc(sel)} (missing)</option>`;
  return o;
}
/**
 * @param {VoiceRow[]} list
 * @param {string} name — a filename; may not be in `list` (a voice deleted out from under a
 *   saved reference), in which case the name itself is the fallback label.
 * @returns {string}
 */
export const voiceLabelOf = (list, name) => {
  const v = list.find(o => o.name === name);
  return v ? v.label || v.name : name;
};
// Empty-option copy: a DEFAULT-voice dropdown left unset falls back to the voice
// baked into the Chatterbox model itself (which nobody picked, and on a multi-GPU
// pool is unpredictable); a CHARACTER dropdown left unset uses the tab's default.
export const UNSET_DEFAULT_LABEL = "(not set — Chatterbox's built-in voice plays)";
/**
 * @param {VoiceRow[]} list
 * @param {string} def — the default voice's filename, or `''`.
 * @returns {string}
 */
export const useDefaultLabel = (list, def) =>
  def ? `(use default voice — ${voiceLabelOf(list, def)})` : '(use default voice — ⚠ none set above!)';

// ── the ◀ ▶ voice steppers (7.3-m6d) ─────────────────────────────────────────────────────────
// 🔴 IT CAME OUT OF THE MIDDLE OF THE PLAYGROUND BANNER, WHICH IS WHERE IT WAS DECLARED AND IS NOT
// WHERE IT BELONGS — the m4o move, third instance (after `ui/fav.js`'s ★ and `ui/audition.js`'s
// wireAudCluster). FOUR features step a voice select: the Playground, the Book tab, the
// SillyTavern character rows (js/st/chars.js) and the shared audition cluster
// (js/ui/audition.js). Leaving it in `pg/playground.js` would have two of those importing a
// four-line helper from a sibling FEATURE, and it is what would have made the Playground cut two
// ranges instead of one.
//
// 📌 `bubbles:true` IS THE WHOLE FUNCTION. A synthetic Event does not bubble by default, and the
// SillyTavern tab's dirty tracking is a DELEGATED listener — so without it, stepping a voice with
// the arrows changes the select and the card never registers as edited.
/**
 * @param {string} selId
 * @param {number} d — `-1` or `1`.
 */
export function stepVoice(selId, d) {
  const s = /** @type {HTMLSelectElement} */ ($(selId)),
    n = s.options.length;
  if (!n) return;
  // bubbles:true — synthetic events don't bubble by default, and delegated
  // listeners (e.g. the SillyTavern tab's dirty tracking) must hear this.
  s.selectedIndex = (s.selectedIndex + d + n) % n;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}
