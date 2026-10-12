// vcstate.js — the Voices tab's own state and the two hooks other modules reach it through.
//
// 🔴 THIS IS js/st/tabstate.js's SHAPE, FOR THE SAME REASON, ONE TAB OVER (7.5.6). js/voices/
// voices.js imports from sys/model.js, voice/candidates.js and voice/batch.js, and all three
// imported names straight back out of it — a four-module strongly-connected component, which has
// no defined evaluation order, which a bundler therefore linearizes differently from the browser.
// js/ui/tabswitch.js carries the full argument; this is the same cut.
//
// ⚠️ `vcTab` LIVES HERE NOW, NOT IN voices.js, and the accessor is the export rather than the
// binding. voices.js reassigns it in `switchVTab`, and an `export let` copied through
// `Object.assign(window, …)` would freeze at load — which is the bug `vcTabNow()` was created to
// fix in the first place, when js/voice/batch.js read a bare `vcTab` and got a stale one.
// ⚠️ `string`, NOT the narrower `'upload'|'create'` the value is always actually one of:
// `switchVTab` (voices.js) is fed straight from a clicked `<th>`'s `dataset.vtab`, which
// `dom-permissive.d.ts` types as a bare `string` — narrowing here would only move an unchecked
// cast from this write site to that read site.
/** @type {string} */
let vcTab = 'upload';

/** The Voices sub-tab showing right now. A function, because the `let` above is reassigned. */
export const vcTabNow = () => vcTab;

/** Only `switchVTab` in voices.js should call this.
 * @param {string} name — 'upload' or 'create' at runtime; see the `vcTab` note above. */
export const vcTabSet = name => {
  vcTab = name;
};

// ── the two hooks ───────────────────────────────────────────────────────────────────────────
// Neither implementation could move here: `vcSyncModel` reads MODELS and drives `switchVTab`, and
// `loadVoiceList` renders the list. Only the SUBSCRIPTION moves, which is the half with no
// dependencies. 📌 Both default to a no-op so firing before voices.js has evaluated does nothing
// rather than throwing.
// 🔴 THE STUB IS TYPED, NOT THE CALL SITE — same shape as `pg/pgstate.js`'s `_loadLib`/`_onEdited`.
/** @type {() => void} */
let _sync = () => {};
/** @param {() => void} fn */
export function onVcSyncModel(fn) {
  _sync = fn;
}
export function vcSyncModelFire() {
  _sync();
}

// ⚠️ Returns the promise, so an awaiting caller still awaits the real load.
/** @type {() => Promise<void>} */
let _loadList = async () => {};
/** @param {() => Promise<void>} fn */
export function onVoiceListLoad(fn) {
  _loadList = fn;
}
/** @returns {Promise<void>} */
export function voiceListLoad() {
  return _loadList();
}
