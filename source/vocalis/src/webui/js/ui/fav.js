// ui/fav.js — the ★, and it is ONE shape for every list in the app (7.3-m4o).
//
// Moved verbatim out of the MIDDLE of index.html's `── swap library: Finished songs | Stems ──`
// banner, which is where these three were declared and is not where they belong.
//
// 🔴 IT CAME OUT OF THE SWAP LIBRARY AND IT IS NOT SWAP-LIBRARY CODE. Twelve call sites across FOUR
// unrelated features read these: the Voices list (`vfav`), the Voice-Swap picker's two halves
// (`favsong`, `favvoice`), the swap library itself (`favswap`) and the Stems picker (`favsong2`,
// `favvoice2`). Filing them under `media/` would leave `voices/list.js` (m8) and `media/stemsets.js`
// importing a button from `media/swaplib.js` — §4's cycle, arriving as a filing error rather than as
// a design one. The page had already noticed: the comment above `voiceOrder`, 3,500 lines earlier,
// reads *"⚠ favFirst is declared much further down (the Voice Swap block). That is fine because
// every use is inside a function."* It is declared here now, and that note is still true.
//
// 📌 NOTHING HERE WIRES AT MODULE LOAD. Unlike stemwidget.js, bulk.js or devices.js, importing this
// file has no effect beyond publishing three names — every caller is a render or a click handler.
//
// ⚠️ THAT EVERY CALL SITE IS INSIDE A FUNCTION BODY IS WHAT MAKES THIS MOVABLE AT ALL (§3.1).
// `favFirst` is the one to watch: it is named by `voiceOrder` and `vOrder`, which are both arrow
// bodies and therefore deferred, so no bare reference to it is READ while the page parses and none
// of the three needs a `_PARSE_TIME_SURFACE` pin. Re-check that before wiring one at top level —
// §11.8 is about exactly the reference shape these three would take.
//
// ⚠️ `tests/voices_ui_smoke.mjs` PULLS THE REAL `favBtn` AND `favFirst` DECLARATIONS IN BY REGEX
// rather than restating them, deliberately: *"a local copy would keep passing after the original
// changed."* Its `decl()` searches the module tree through `_websrc.mjs` and tolerates the `export`
// keyword as of m4o; before that it read the inline block alone and this move would have failed it.

import { esc } from '../util/dom.js';
import { jpost } from '../util/http.js';
import { modal } from './modal.js';

// ★ — one button, one shape, three lists (songs, voices, finished songs). `k` names the
// data-attribute the list's own click handler listens for. Gold ONLY when set: a column of
// buttons all wearing the same gold says nothing, and the point of a star is that it stands out.
/**
 * @param {string} k — the `data-*` attribute name the list's delegated click handler reads
 *   (e.g. `'favsong'` renders `data-favsong`).
 * @param {string} ref
 * @param {boolean} [on]
 * @returns {string}
 */
export const favBtn = (k, ref, on) =>
  `<button class="sm fav${on ? ' on' : ''}" data-${k}="${esc(ref)}" ` +
  `title="${on ? 'Remove from favorites' : 'Add to favorites'}">${on ? '★' : '☆'}</button>`;
// Favorites float to the TOP of every list, keeping each list's own order within both halves
// (Array.sort is stable). This beats a "favorites only" toggle, which HIDES everything else:
// a picker you use daily shouldn't make you scroll past six experiments to reach the voice you
// always pick, but it also shouldn't stop you seeing the six.
/**
 * 🔴 GENERIC ON THE ROW TYPE, LIKE `filtRows` — callers hand this everything from `VoiceRow[]` to
 * a swap-library row with a dozen other fields, and a plain `{favorite?:boolean}[]` here would
 * throw all of it away and make the caller re-cast the result.
 * @template {{favorite?: boolean}} T
 * @param {T[]} a
 * @returns {T[]}
 */
export const favFirst = a => [...a].sort((x, y) => (y.favorite ? 1 : 0) - (x.favorite ? 1 : 0));
// One POST, one refresh. `reload` re-reads from the server rather than patching the row in
// place, because the sidecar on disk is the truth and a star that only exists in the DOM is
// a lie the next refresh silently corrects.
/**
 * @param {string} url
 * @param {boolean|undefined} cur — the row's CURRENT `favorite`, before the toggle; `!cur` is
 *   what gets POSTed. ⚠️ `undefined` is a real call-site value (a row whose `favorite` was never
 *   set), and it must read as `false` here — see the 7.5.10 incident at `VsRow` in
 *   `media/voiceswap.js`, where an undefined `cur` posted `{favorite:true}` unconditionally.
 * @param {() => Promise<void>} reload
 */
export async function favToggle(url, cur, reload) {
  try {
    await jpost(url, { favorite: !cur });
  } catch (e) {
    await modal('Favorite failed', esc(/** @type {ErrLike} */ (e).message || 'could not save'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  await reload();
}
