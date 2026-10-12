// Shared Stems rendering for the Stems library.
// A pill click updates the existing audio element so playback position survives.

import { $, esc } from '../util/dom.js';
import { fmtDur, fmtSize } from '../util/fmt.js';
// ── the stem widget (M4 §7) ─────────────────────────────────────────────────
// ONE player and a row of pills — never busier than a single row, whether the set has
// 2 stems or 6. Both the Stems tab and the swap library's Stems view render through
// this, which is why the two look and behave identically.
//
// A pill click re-points the EXISTING <audio> rather than re-rendering the row: a
// rebuilt element loses its playback state (and, per §7h, anything that repaints is
// built once and updated in place). Rows are collapsed by default — you come here to
// find one set, not to read all of them.
/** One playable stem, or a swap's dry vocal / a set's instrumental — the two callers (this file's
 * own `stemPills`, and `media/swaplib.js`'s hand-built pills over `/voiceswap/library` rows) build
 * the same shape from different stores, so `key` is optional rather than shared identity.
 * @typedef {object} StemPill
 * @property {string} [key]
 * @property {string} label
 * @property {string} url
 * @property {string} dl
 * @property {number} [size]
 */
/** @typedef {object} StemWidgetOpts
 * Configuration and renderer contract for a stem widget.
 * @property {string} title
 * @property {string} [meta]
 * @property {{text:string,cls?:string}[]} [badges]
 * @property {StemPill[]} [pills]
 * @property {boolean} [open]
 * @property {string} [pick] Ref used by bulk-select checkboxes.
 * @property {string} [key] Stable row identity for reconciliation; falls back to pick, then an instance counter.
 * @property {number} [size]
 * @property {string|null} [zip]
 * @property {string} [acts]
 * @property {string} [note] File-specific note shown below the pills.
 * @property {string} [drag] Reference used when the row participates in folder drag-and-drop.
 * @property {string} [tag] Folder label shown when filtering flattens the list.
 */

/** @type {Record<string, StemPill[]|undefined>} */
const stemW = {}; // widget id → its pills, so a click can resolve one
let stemWn = 0;
/** row key → the widget id it was first given, stable for the life of the page. */
const stemIds = new Map();

/** Generate stable ids through a key map and counter; never derive them from refs, which may collide after sanitization. This lets reconciliation preserve each row and its playback state.
 * @param {string} key
 */
function widgetId(key) {
  if (!key) return 'sw' + ++stemWn;
  let id = stemIds.get(key);
  if (!id) {
    id = 'sw' + ++stemWn;
    stemIds.set(key, id);
  }
  return id;
}

/** @param {StemWidgetOpts} o */
export function stemWidgetHTML(o) {
  const id = widgetId(o.key || o.pick || '');
  stemW[id] = o.pills;
  // Keep the folder tag inside this keyed row; reconciliation drops unkeyed sibling children.
  const badges = (o.badges || []).map(b => `<span class="badge ${b.cls || ''}">${esc(b.text)}</span>`).join(' ') + (o.tag || '');
  const pills = (o.pills || [])
    .map(
      (p, i) =>
        `<button class="pill${i === 0 ? ' on' : ''}" data-sw="${id}" data-i="${i}" title="Play ${esc(p.label)}${p.size ? ` (${fmtSize(p.size)})` : ''}">${esc(p.label)}</button>`,
    )
    .join('');
  const first = (o.pills || [])[0];
  return `<div class="stemset${o.open ? ' open' : ''}" data-swset="${id}" data-setkey="${esc(o.key || o.pick || id)}"${
    o.drag ? ` data-vrow="${esc(o.drag)}" draggable="true"` : ''
  }>
    <div class="stemhead" data-swhead="${id}">
      ${o.pick ? `<input type="checkbox" class="sspick" data-sspick="${esc(o.pick)}" data-size="${o.size || 0}" title="Select this set for a bulk delete" style="margin:0 2px 0 0;flex:0 0 auto">` : ''}
      <span class="caret">▶</span>
      <div class="grow"><div class="t">${esc(o.title)} ${badges}</div>
        <div class="m">${o.meta || ''}</div></div>
      ${o.acts || ''}</div>
    <div class="stembody">
      <div class="stemplay">
        <audio controls preload="none" id="${id}a" src="${first ? first.url : ''}" style="flex:1;min-width:240px"></audio>
        <a class="abtn" id="${id}d" href="${first ? first.dl : '#'}" title="Download the stem you're playing">⬇ <span id="${id}n">${first ? esc(first.label) : ''}</span></a>
        ${o.zip ? `<a class="abtn" href="${o.zip}" title="Download every stem in this set as one zip — however many it holds, saving them one at a time is not 'give me the stems'">⬇ All</a>` : ''}
      </div>
      <div class="stempills">${pills}</div>
      ${o.note ? `<div class="m" style="margin-top:6px">${o.note}</div>` : ''}
    </div></div>`;
}

// One delegated handler for every widget on the page: open/close a set, or re-point
// its player at another stem.
document.addEventListener('click', e => {
  const pill = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-sw]'));
  if (pill) {
    const id = /** @type {string} */ (pill.dataset.sw),
      p = (stemW[id] || [])[+(/** @type {string} */ (pill.dataset.i))];
    if (!p) return;
    document.querySelectorAll(`[data-sw="${id}"]`).forEach(b => b.classList.toggle('on', b === pill));
    const a = /** @type {HTMLAudioElement} */ ($(id + 'a'));
    if (a) {
      a.src = p.url;
      a.play().catch(() => {});
    }
    const d = /** @type {HTMLAnchorElement} */ ($(id + 'd'));
    if (d) d.href = p.dl;
    const n = $(id + 'n');
    if (n) n.textContent = p.label;
    return;
  }
  const head = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-swhead]'));
  // A button inside the header (🎓, ✕) is an action, not a disclosure toggle.
  // 7.5.17 — and neither is the multi-select checkbox. Without this exclusion every tick would
  // also expand the set, so selecting six for a delete would leave six players open behind the
  // dialog — and the SECOND click to collapse it would untick the box again.
  if (
    head &&
    !(/** @type {HTMLElement} */ (e.target).closest('button:not([data-swhead])')) &&
    !(/** @type {HTMLElement} */ (e.target).closest('a')) &&
    !(/** @type {HTMLElement} */ (e.target).closest('[data-sspick]'))
  ) {
    const set = document.querySelector(`[data-swset="${head.dataset.swhead}"]`);
    if (set) set.classList.toggle('open');
  }
});
// `Record<string,string>`, not the literal object it is written as: both this file and
// voiceswap.js index it with a `mode` string read off a fetched row, never with one of the keys
// directly, so a narrower type would reject every real call site. 8.4 is the event that reasoning
// was written for — `mode_of` grew two more answers, this map grew with it, and not one call site
// had to change.
/** @type {Record<string,string>} */
export const STEM_MODE = {
  '2stem': '2-stem',
  '4stem': '4-stem',
  // 8.4 §6 R6. `mode_of` used to answer `2stem` for anything that was not 4-stem, and over a
  // "Lead vocals only" set — one vocal, no instrumental — that badge was simply false. `vocals`
  // names what the folder HAS, and it is a mode in its own right rather than a failed 2-stem, so
  // the label says what the set IS instead of what it is missing.
  'vocals': 'vocals only',
  // Baseless AND vocal-less — a lone uploaded instrumental, which read as `2stem` for the same
  // wrong reason. Storable and downloadable, just never swappable (§5).
  'partial': 'partial',
};
// ── Route-row types (carried over from the legacy `media/swapstate.js`) ──────────────────────
// 🔴 The legacy app kept these typedefs in `media/swapstate.js`, next to Voice Swap's `vs` state.
// Voice Swap execution is not part of this product, so that module is not here, and the JSDoc
// `import('./swapstate.js')` references that used to resolve to it were 31 tsc errors (TS2307 and
// the implicit-any cascade behind them). This file is the leaf that both `media/stems.js` (the
// only reader of `/voiceswap/songs` and `/stems/library` rows in this product) and the widget
// below already depend on, so the full row shapes live here, once; `stems.js` aliases them.
// The single `StemSet` below replaces the narrower structural one this file used to declare for
// itself — two typedefs of one row shape is how `lead.thin` came to be required here and optional
// there.

/** Song or audio-library row listed by `/voiceswap/songs`.
 * * @typedef {object} SongRow
 * @property {string} ref
 * @property {string} name
 * @property {string} source        'uploads' · 'acestep' · 'acelib'
 * @property {boolean} [favorite]
 * @property {number} [size]
 * @property {number} [mtime]
 * @property {number|string} [seed]
 * @property {string|null} [folder]  8.9: the virtual folder's id, or absent/null for unfiled.
 *   Stamped by the server (`folders.for_rows`, scope `voiceswap_songs`, keyed on `ref`).
 *   📌 Content-addressed, so it needs no entry in `folders.RENAME_MOVES_REF`.
 */

/** @typedef {object} StemFile
 * One separated audio stem and its metadata.
 * @property {string} stem   Canonical identity: 'vocals' · 'instrumental' · 'drums' · 'bass' ·
 *   'other'. 🔴 Compare THIS, never `file` — `file` is `instrumental.opus` on anything split
 *   since the format change and `.wav` on sets that predate it (7.5.25).
 * @property {string} file
 * @property {string} label
 * @property {number} [size]
 * @property {boolean} [derived]  8.4 — made FROM another stem in the set (`lead_solo`)
 *   rather than by Demucs. It is a pill and a zip entry, but it is not one of the N stems
 *   the mode badge is counting, and the row must be able to tell them apart without
 *   re-deriving it from the name.
 */

/** One Demucs separation in the stem library, keyed by source content hash.
 * * @typedef {object} StemSet
 * @property {string} ref
 * @property {string} song          The song's title, for display.
 * @property {string} [song_ref]    The `/voiceswap/songs` ref it was split from — absent on a
 *   brought-in set (§7's own upload has no song of its own).
 * @property {string} source        'uploaded', or the split source, e.g. 'acestep'.
 * @property {string} mode          '2stem' | '4stem' | 'vocals' | 'partial' — a STEM_MODE
 *   key. 🔴 `vocals` is 8.4's baseless set: one vocal, no instrumental, which is what
 *   "Lead vocals only" leaves and is correct rather than a regression. `partial` is
 *   baseless AND vocal-less. Both used to answer `2stem`, which the UI then repeated
 *   everywhere as a badge that was simply false.
 * @property {StemFile[]} stems
 * @property {boolean} [swappable]  Has a vocals stem — nothing to convert without one.
 * @property {number} [size]
 * @property {number} [duration_s]
 * @property {number} [created_ts]
 * @property {number} [swaps]       Finished Voice Swaps that borrow this set's instrumental.
 * @property {string} [h]           The song's content hash.
 * @property {LeadBlock|null} [lead] 8.4's `lead:` sidecar block, or null on every set that
 *   has never been through "Lead vocals only".
 * @property {string|null} [folder] 8.9: the virtual folder this set is filed in, stamped by
 *   `folders.for_rows` on `/stems/library` under the `stems_library` scope. Optional because
 *   this typedef also describes the payload as it looked before 8.9 and every reader treats a
 *   missing value as unfiled — the same reading `folderRows` gives it.
 */

/** Metadata for a lead-vocal-only separation, including the source and retained range.
 * * @typedef {object} LeadBlock
 * @property {string} [built_at]
 * @property {string} [detector]      Which model decided where she was singing alone.
 * @property {string} [device]
 * @property {string|boolean} [dereverb]
 * @property {string} [dereverb_skipped] Present only when the de-reverbed audio was thrown
 *   away — it was not sample-aligned with the file the spans were measured on (§3.5), so
 *   the cut was made on the wet vocal instead. A song with its reverb still in it is a
 *   usable dataset; a song cut at the wrong places is not.
 * @property {Record<string, number|boolean>} [params]  The LeadParams the cut actually
 *   used — every threshold, so a set can be re-cut on exactly its own settings and the
 *   Backing threshold field can prefill from what THIS song needed (§4d.2 measured the
 *   right value to be per-song, not global).
 * @property {number} [spans]
 * @property {number} [kept_sec]
 * @property {number} [source_sec]
 * @property {string} [detector_warning] Set when the karaoke model handed back a near-copy of
 *   the lead instead of separating it (§9.8), so this set's spans mean nothing. Present ONLY
 *   when it fired. It outranks `thin`: an empty result normally says the song is stacked
 *   end to end, and when this is set it says nothing about the song at all.
 *   ⚠️ The text after `[detector_warning]` starts with a plain ASCII word ON PURPOSE — a
 *   `§` or an em dash immediately after an [optional] param name is TS1127 to tsc's JSDoc
 *   parser, which is a known trap in this codebase and cost a build here.
 * @property {boolean} [thin]         Under 15s of usable lead came back. A real answer
 *   about a stacked song, not a failure — which is why it is badged and not raised.
 */

/** The picked song (from the song list or a resumable live job).
 * * @typedef {object} SwapSourceSel
 * @property {string} ref
 * @property {string} name
 * @property {string} [kind]
 * @property {string} [source]
 * @property {boolean} [swappable]
 * @property {string} [meta]
 * @property {boolean} [band_limited]
 * @property {number} [duration_s]
 * @property {number} [size]
 * @property {number} [mtime]
 * @property {number|string} [seed]
 */

/** @param {StemSet} s */
export function stemBadges(s) {
  const b = [{ text: STEM_MODE[s.mode] || s.mode }, s.source === 'uploaded' ? { text: 'uploaded', cls: 'up' } : { text: 'split' }];
  // §6 R1: whether a lead was cut is a SEPARATE question from which mode the set satisfies, so
  // this badge is ADDED and never replaces the mode's. The mode badge has to keep saying what
  // DEMUCS left — that is the whole reason `mode_of` stopped answering `2stem` for a baseless set,
  // and hiding it behind a lead badge would put the same lie back one layer up.
  //
  // What is worth knowing at a glance is how much came back (§7's QA affordance): a detector that
  // ran too hot reads as "⚠ thin lead · 0m 11s" right on the row, so a bad cut is visible without
  // opening the file. Amber, not the badge's other two variants — `up` and `cleaned` are both
  // GREENS, and a thin result is precisely not that.
  if (s.lead)
    b.push(s.lead.thin ? { text: `⚠ thin lead · ${fmtDur(s.lead.kept_sec)}`, cls: 'warn' } : { text: `lead · ${fmtDur(s.lead.kept_sec)}` });
  return b;
}
/** @param {StemSet} s
 * @returns {StemPill[]} */
export function stemPills(s) {
  return (s.stems || []).map(x => ({
    key: x.file,
    label: x.label,
    size: x.size,
    url: `/stems/library/${encodeURIComponent(s.ref)}/${encodeURIComponent(x.file)}/audio`,
    dl: `/stems/library/${encodeURIComponent(s.ref)}/${encodeURIComponent(x.file)}/audio?download=1`,
  }));
}
