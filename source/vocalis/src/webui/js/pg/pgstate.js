// ── Playground: the shared state (7.3-m6e) ───────────────────────────────────────────────────
//
// One object, one timestamp and one URL builder, and it imports NOTHING. The third state module
// of the milestone, after `voice/design.js` (m8a), `st/tabstate.js` (m2b) and
// `media/swapstate.js` (m9a) — and by now the shape is a rule rather than a judgment call:
// **state that several modules read belongs to none of them.**
//
// WHO READS IT:
//
//     pg/playground.js    the tab itself — declares nothing, mutates everything
//     ui/audition.js      pgLib.items ×2 and pgClipUrl ×3: the audition player looks for an
//                         already-rendered clip before spending a GPU on a new one
//     book/job.js         pgStartSet, on the resume-a-render path
//
// 🔴 AND `pgStart` IS THE REASON THIS FILE EXISTS RATHER THAN JUST BEING TIDY. `js/book/job.js`
// ASSIGNS it — one line, on the reconnect path — while the only reader, `pgElapsed`, is here.
// That is `vsStart` (m4m), `jobStart` (m6c) and `vsStart` again (m9a) for the FOURTH time, and
// §11.24 is about the fact that the check meant to catch it could not: it scans the PAGE for
// writers outside the range, and `book/job.js` is not the page.
//
// ⚠️ SO IT IS NOT EXPORTED AS THE `let`. The shim's `Object.assign(window, …)` copies a value
// ONCE, so a published `pgStart` freezes at 0 and a resumed render reports the minutes since
// 1970 — no error, just a number nobody believes. `pgStartNow()` reads and `pgStartSet()` writes
// (m2b's `stTabNow`/`stTabSet` rule, fourth instance), which leaves no second path to a stale
// value. Module-to-module an `import {pgStart}` would have been live and correct; it is the SHIM
// that cannot carry it, and the shim is what any remaining inline caller reaches through.

/** Playground library row for a completed clip or an interrupted/in-progress item.
 * * @typedef {object} PgClip
 * @property {'clip'|'partial'} kind
 * @property {string} ref - '<voice-dir>/<stem>' for a clip; the bare workspace hash for a partial.
 * @property {string} name
 * @property {string} file
 * @property {'mp3'|'wav'} format
 * @property {boolean} favorite
 * @property {string} voice - the raw filename identity; '' for the model default.
 * @property {string} [voice_label] - ⚠️ ALWAYS present on a partial; only present on a clip when
 *   its voice has a cosmetic label set (`playground_clips_list` sets it conditionally for clips,
 *   unconditionally for partials — `src/vocalis/web/playground.py`). Every render site falls
 *   back to `'default'` for its absence.
 * @property {number|null} exaggeration
 * @property {number|null} cfg
 * @property {number|null} temperature
 * @property {boolean} narrate_actions
 * @property {boolean} enhanced
 * @property {number|null} nfe
 * @property {number} [bandwidth_hz] - clips only.
 * @property {boolean} [band_limited] - clips only.
 * @property {string} text
 * @property {string|null} [folder] - 8.9: the id of the virtual folder this clip is filed in, or
 *   absent/null for unfiled. Stamped by the server (`folders.for_rows`, scope `playground_clips`)
 *   and never derived in the client — the server owns the scope's key, and a second opinion about
 *   identity here would be a second thing to get wrong. ⚠️ Present on PARTIALS too: they are rows
 *   in this list, they can be ticked, and a partial keeps its ref when it finishes, so filing one
 *   and having it silently unfile on completion would be exactly the silent drop this feature
 *   keeps tripping over.
 * @property {string|null} created - an ISO timestamp on a clip; always `null` on a partial.
 * @property {number} created_ts - clip: sidecar mtime. Partial: latest banked chunk's mtime.
 * @property {number|null} duration_s - ⚠️ on a partial this is the playable banked PREFIX only,
 *   never the eventual full length — `banked_prefix_seconds` in `src/playground_clips.py`.
 * @property {number} size
 * @property {number} [done] - partials only: chunks banked so far, of `total`.
 * @property {number|null} [total] - partials only: total chunks, or `null` before the manifest
 *   records it (`write_pending` races the first chunk landing).
 * @property {number} [prefix] - partials only: the gapless playable prefix length.
 */

// ⚠️ A `const` THAT IS EXCLUSIVELY MUTATED — §11.4's middle row, the same license `scLib` (m7),
// `vc` (m8a) and `vs` (m9a) hold. Nothing reassigns `pgLib`; every write is a field write, so the
// shim's one-time copy and this binding stay the same object for the life of the page.
/** `sort` stores the selected column name from the table header; it remains a string because it round-trips through `dataset.sort`.
 * * @type {{items: PgClip[], q: string, sort: string, dir: number, page: number, sel: Set<string>}}
 */
export const pgLib = { items: [], q: '', sort: 'created_ts', dir: -1, page: 0, sel: new Set() };

// A clip's audio URL. Pure, and it is here rather than in playground.js because `ui/audition.js`
// calls it three times and importing it from the FEATURE would put a shared helper behind a
// feature import — the m4o argument, and the difference between a cycle and not one.
/**
 * @param {string} ref
 * @returns {string}
 */
export function pgClipUrl(ref) {
  return '/playground/clips/' + ref.split('/').map(encodeURIComponent).join('/') + '/audio';
}

let pgStart = 0;
/** @returns {number} */
export const pgStartNow = () => pgStart;
/** @param {number} t */
export const pgStartSet = t => {
  pgStart = t;
};
/** @returns {string} */
export const pgElapsed = () => {
  const s = Math.floor((Date.now() - pgStart) / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

// ── the "the playground's inputs changed" hook (7.5.6) ──────────────────────────────────────
// 🔴 THIS EXISTS TO BREAK A CYCLE. `sys/enhance.js` imported `pgEdited` from js/pg/playground.js,
// and playground.js imports eight names back out of enhance.js — a mutual edge, and one strand of
// the 18-module strongly-connected component that had no defined evaluation order and therefore
// bundled in an order the browser never used. `pgEdited` itself cannot move here: it calls three
// of playground's own internals (`pgDisarmResume`, `pgUpdateAudition`, `pgUpdateTake`). So the
// SUBSCRIPTION moved instead, which is the half that has no dependencies at all.
//
// ⚠️ ONE SLOT, LAST WRITER WINS, AND THAT IS DELIBERATE RATHER THAN LAZY. There is exactly one
// `pgEdited` and exactly one module entitled to define it. A list would let a second registration
// pass silently, and two things claiming to be "the playground was edited" is a bug worth failing
// on rather than averaging over.
// 📌 The default is a no-op, so firing before playground has evaluated does nothing instead of
// throwing. Nothing can reach the button that fires it until the page is wired, and a dead click
// beats a dead page.
// The Playground's clip library, reloaded from outside. `loadPgLib` cannot move here either --
// it renders the list and updates two audition panels -- so once again only the subscription does.
// 📌 RULE: anything OUTSIDE pg/ asks through this. Only two of the five callers were part of the
// cycle (st/chars.js, ui/audition.js), but a direct import is legal for the other three and that is
// exactly the trap: two ways to ask the same question, one of which quietly re-forms the cycle.
// ⚠️ Returns the promise, so an awaiting caller still awaits the real load.
// 🔴 THE STUB IS TYPED, NOT THE CALL SITE (§L6's worked example is `voice/vtbus.js`). Every
// caller of `pgLibLoad()` sees THIS signature, never `loadPgLib`'s own — so if a future
// registration returns something other than `Promise<void>`, the mismatch has to show up at
// `onPgLibLoad(fn)`'s call site, not silently widen every reader of `pgLibLoad()` to `any`.
/** @type {() => Promise<void>} */
let _loadLib = async () => {};
/** @param {() => Promise<void>} fn */
export function onPgLibLoad(fn) {
  _loadLib = fn;
}
/** @returns {Promise<void>} */
export function pgLibLoad() {
  return _loadLib();
}

/** @type {() => void} */
let _onEdited = () => {};
/** @param {() => void} fn */
export function onPgEdited(fn) {
  _onEdited = fn;
}
export function pgEditedFire() {
  _onEdited();
}
