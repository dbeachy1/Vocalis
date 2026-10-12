// util/filter.js — ONE FILTER, EVERY LIST (7.3-m1b).
//
// Nine panels have a scrolling list and a ↻ Refresh, and every one of them gets busy long
// before it gets big. They all share this, so a filter behaves identically wherever you meet
// one, instead of nine boxes with nine subtly different ideas of what "matching" means.
//
// EVERY WORD TYPED must appear somewhere in the row's searchable text, IN ANY ORDER. Two
// words beat one substring: "sample voice" finds the row that "samplevoice" never would, and you
// don't have to remember whether the song or the voice comes first. The lists are small
// enough that re-filtering on every keystroke costs nothing measurable.
//
// It filters the DISPLAY ONLY — the underlying arrays stay whole. So play, download, delete
// and rename all still resolve a ref that has been filtered off the screen, which is what
// lets the player at the top of a library keep working while you type a filter that excludes
// the very thing it is playing.
//
// 🔴 `filtWire` IS NOT IN THIS FILE, AND THAT IS DELIBERATE — DO NOT "FINISH THE JOB".
// It is one of the nine names called at parse time (DESIGN_7_3_FRONTEND_SPLIT.md §3.1a), so
// its body runs while the document is still parsing. A `type="module"` script is deferred and
// has not run at that moment, so a `filtWire` living here would be `undefined` at the only
// instant it is needed, and the page would come up with **no filter box wired at all** —
// silently, because nothing throws when you never call the thing. It stays inline until its
// parse-time callers move, which is m12. `tests/test_webui_parsetime.py` fails by name if
// anyone tries.
//
// ⚠️ WHY `FILT` COULD MOVE WHEN `filtWire` COULD NOT, given filtWire writes to it.
// `filtWire`'s only touch of `FILT` is inside its `on` handler — `FILT[id]=e.target.value` —
// and a handler cannot fire before there is a user, which is long after the shim has run.
// The shim's `Object.assign` copies the *object reference*, so the inline handler and this
// module mutate and read the same object. Had `filtWire` read `FILT` in its own body, this
// split would not have been available.

import { $, esc } from './dom.js'; // 7.3-m13: `$` was reached off the shim; `filtWire` below needs it

// input id → the query typed into it
/** @type {Record<string, string>} */
export const FILT = {};

/**
 * The query currently typed into filter box `id`, trimmed. `''` when there is none.
 * @param {string} id — the `<input>`'s element id, which is also this box's key in `FILT`.
 * @returns {string}
 */
export const filtQ = id => (FILT[id] || '').trim();

/**
 * @param {unknown} hay — a row's searchable text. Typed loosely because the `text(row)` callbacks
 *   build it from payload fields that are routinely numbers or absent; the `hay == null` line
 *   below is what handles that, and it predates the types.
 * @param {string} q
 * @returns {boolean} every word in `q` appears somewhere in `hay`, in any order.
 */
export const filtMatch = (hay, q) => {
  const h = String(hay == null ? '' : hay).toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(w => h.includes(w));
};

// `text(row)` returns everything about a row that is worth searching.
/**
 * Keep row types generic so callers retain their concrete result types without casts.
 * @template T
 * @param {string} id
 * @param {T[]} rows
 * @param {(row: T) => unknown} text
 * @returns {T[]} the matching rows, or `rows` itself when the box is empty.
 */
export const filtRows = (id, rows, text) => {
  const q = filtQ(id);
  return q ? rows.filter(r => filtMatch(text(r), q)) : rows;
};

/**
 * @param {string} id
 * @returns {string}
 */
export const filtNone = id => `<span class="muted">Nothing matches “${esc(filtQ(id))}”.</span>`;

// "3 of 6 songs" — the count has to describe what is ON SCREEN. A header that went on quoting
// the whole library while the list showed three rows would be reporting on something you
// cannot see. Unfiltered, it reads exactly as it did before.
/**
 * ⚠️ `id` IS NOT READ BY THIS FUNCTION, and typing it is what made that visible. The "n of all"
 * decision is `n < all`, taken from the counts the caller already computed, so there is nothing
 * here to look up. Nine call sites pass one; the parameter stays because dropping it is a
 * signature change across all nine and this milestone changes no code. Written down rather than
 * removed, so the next reader does not go looking for the lookup.
 *
 * @param {string} id
 * @param {number} n — rows on screen after filtering.
 * @param {number} all — rows in the unfiltered set. Falsy means "nothing loaded" → no count.
 * @param {string} noun — singular; an `s` is appended unless `n === 1`.
 * @returns {string}
 */
// 🔴 THE PLURAL FOLLOWS THE NUMBER THE NOUN ACTUALLY SITS BEHIND (9.7.0). In the "1 of 30" form
// that is the TOTAL, not the shown count — so keying `s` off `n` printed "1 of 30 song" the moment
// a filter left exactly one row, which is the commonest filtered state there is. `media/swaplib.js`
// fixed this in its own hand-rolled copy of the sentence and the shared helper never got it; nine
// panels have been saying it since 7.3-m1b. Cosmetic, two characters, and it is the line every
// filtered list on the page renders.
export const filtCount = (id, n, all, noun) =>
  !all ? '' : `— ${n < all ? `${n} of ${all}` : n} ${noun}${(n < all ? all : n) === 1 ? '' : 's'}`;

// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ `filtWire` ARRIVED AT 7.3-m13, AND IT IS THE LAST FUNCTION TO LEAVE index.html. m1b took the
// other six and left this one behind with a written removal condition — *"it is called at parse
// time (§3.1a), and a module is deferred, so moving it would wire no filter box on the page at
// all"* — which was exactly right for as long as there was a page script to call it from.
//
// 🔴 ITS NINE CALL SITES DID **NOT** COME HERE. They are `js/ui/filterwiring.js`, and the split is
// the whole reason this file is still a leaf. The calls name renderers from TEN feature modules
// (book/library, pg/playground, voices/voices, media/voiceswap ×4, voice/training ×2) and every one
// of those imports `filtRows`/`filtQ`/`filtNone`/`filtCount` from HERE. Putting the calls in this
// file would make `util/filter.js` import all ten of its own importers — ten cycles, to save a
// file. A sink that nothing imports has none.
//
// ✅ AND THE ARROWS ARE NOW OPTIONAL RATHER THAN LOAD-BEARING. §11.8 charged four times for
// `filtWire('x', renderX)` needing to be `()=>renderX()`, because that block was read while the
// page parsed and a module export is in its temporal dead zone until the shim runs. In a module
// the imports are resolved before the body's first statement, so a bare reference would be fine.
// ⚠️ **They stayed arrows anyway**, verbatim, because §6 step 4 says move code without reformatting
// it and because a re-render is what these lines are for — see filterwiring.js's header.
/**
 * @param {string} id — the filter `<input>`'s element id, and this box's key in `FILT`.
 * @param {() => void} render — re-paints the list this box filters. Called on every keystroke.
 */
export function filtWire(id, render) {
  const el = $(id);
  if (!el) return;
  /** @param {Event} e */
  const on = e => {
    FILT[id] = /** @type {HTMLInputElement} */ (e.target).value;
    render();
  };
  // 'search' fires on the native ✕ and on Escape; 'input' on every keystroke. Both, so clearing
  // the box restores the list without needing a Refresh.
  el.addEventListener('input', on);
  el.addEventListener('search', on);
}
