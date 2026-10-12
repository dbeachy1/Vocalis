// The three helpers every other module needs. 7.1 §5 — the first leaf of the module tree.
//
// 🔴 THESE ARE DELIBERATE DUPLICATES OF THE ONES STILL DEFINED INSIDE index.html, AND BOTH COPIES
// HAVE TO EXIST UNTIL THE INLINE SCRIPT IS GONE. See DESIGN_7_1_FRONTEND_REFACTOR.md §5.3.
//
// The reason is `type="module"` deferral. A module runs AFTER the whole classic inline script has
// parsed and executed, and that script calls `$` at parse time — `$('overlay').addEventListener(…)`,
// `$('vcSelAll').onclick = …` and roughly a thousand more. Move `$` out and every one of those sees
// `undefined` while the page is loading, which presents as "the entire UI is dead" rather than as
// "one helper moved". So the inline pair stays until there is no inline script left to need it.
//
// ⚠️ THE REMOVAL CONDITION IS SINGULAR AND IT IS THE INLINE COPY THAT GOES: delete
// `const $=` / `const esc=` from index.html when the last inline caller becomes a module, and this
// file becomes the only definition. Deleting THIS one instead, to "remove the duplication", breaks
// every module that imports it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ `esc` HAS DONE THAT (7.3-m8c). THIS IS THE ONLY COPY, AND HERE IS THE WHOLE ARGUMENT.
//
// The condition above says "when the last inline caller becomes a module", and that is not quite the
// test — index.html still calls `esc` 210 times. The test is the last PARSE-TIME caller, because
// runtime callers resolve `esc` off `window` and the shim's `Object.assign(window, utilDomMod)` has
// put it there long before any of them fires. `$` and `esc` differed only in how many parse-time
// callers each had: `$` has 91 top-level `$('id')…` statements, and `esc` had exactly ONE reader,
// inside the `vcInitLang` IIFE —
//
//     $('vcLang').innerHTML = VC_LANGS.map(l=>`<option>${esc(l[0])}</option>`).join('');
//
// — where `.map` calls its callback NOW, during parsing. 7.3-m8b moved that IIFE into
// js/voices/voices.js with the rest of the Voices tab, and `esc` left the parse-time surface.
//
// 🔴 THE TELL IS A NAME LEAVING `_PARSE_TIME_SURFACE`, AND THAT IS WHY THAT PIN FAILS IN BOTH
// DIRECTIONS. tests/test_webui_parsetime.py reported `LEFT esc — its last parse-time caller is gone.
// If it is one of the DUPLICATED helpers, delete the inline copy and its drift test in the same
// commit.` Nobody would have looked at that tree and seen a decision; the guard is what makes it one.
// It asserts the absence now, so a new parse-time `esc` caller fails there rather than shipping
// against a module copy that is `undefined` at that moment.
//
// 📌 SECOND INSTANCE OF THE `wbEl` ENDING (7.1-m13 was the first, DESIGN_7_1 §5.3/§7). The pattern is
// worth naming because it is the only way a deliberate duplication ever ends: **the inline copy has
// no removal date, it has a removal CONDITION, and a guard reports when the condition is met.**
//
// ⚠️ AND `esc`'s DRIFT TEST WENT WITH IT, WHICH IS THE POINT RATHER THAN A LOSS. A drift test over
// one copy cannot fail. What it was protecting — two escapers disagreeing, an injection hole in
// whichever half is behind — is now unreachable by construction, which is strictly better than a
// test that watches for it.

/** Look up an element by id. The result is nullable and uses `VEl` as its declared base; callers must narrow to the concrete element type before using element-specific properties.
 * @param {string} id
 * @returns {VEl|null}
 */
export const $ = id => /** @type {VEl|null} */ (document.getElementById(id));

/** Escape a value for insertion into HTML text or attribute markup. Quotes are escaped because callers use this for attribute values.
 * @param {unknown} s
 * @returns {string}
 */
export const esc = s =>
  String(s == null ? '' : s).replace(/[&<>"]/g, m => /** @type {string} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// ── 9.0.7: TWO ROWS ANSWERING TO ONE IDENTITY ────────────────────────────────────────────────
//
// 🔴 EVERY ONE OF THESE LISTS IS KEYED, AND A REPEATED KEY IS INVISIBLE UNTIL YOU CLICK. The
// selection, the tick, the highlight and the folder drag are all `id === row.id` comparisons over
// a list the CLIENT composes — Voice Swap ▸ Sources concatenates five separate stores, each
// prefixing its own refs — so a duplicate key does not look like a duplicate row. It looks like
// one click selecting several rows with unrelated names, which is exactly what was reported and
// is nobody's idea of a list bug. `folderReconcileRows` states the same requirement for its own
// reasons (*"two entries sharing one id would silently collapse into a single element"*) and
// nothing enforced it anywhere.
//
// ⚠️ IT REPORTS RATHER THAN REPAIRS, AND THAT IS THE DELIBERATE HALF. De-duplicating here would
// make the symptom disappear while HIDING a source: if two genuinely different files have
// collided on one ref, dropping the second removes a row the user can see is missing but cannot
// explain. The list is not this function's to edit — it is here to name the collision, in the
// panel's own log, the first time it happens.
//
// 📌 ONCE PER (list, id). These renders run at 2 Hz on some panels; a message per repaint would
// bury the one that matters and make the log useless for everything else.
/** @type {Set<string>} */
const _DUPES = new Set();

/**
 * The ids that appear more than once — empty, which is the answer on every correct list.
 * @param {string} label — the list, for the caller's message
 * @param {any[]} rows
 * @param {(row: any) => string} idOf
 * @returns {string[]} newly-seen duplicated ids, in first-seen order
 */
export function dupeIds(label, rows, idOf) {
  const seen = new Set(),
    out = [];
  for (const r of rows || []) {
    const id = String(idOf(r) ?? '');
    if (!seen.has(id)) {
      seen.add(id);
      continue;
    }
    const k = label + '\0' + id;
    if (_DUPES.has(k)) continue;
    _DUPES.add(k);
    out.push(id);
  }
  return out;
}


/** Look up a kind-specific editor element. The result remains nullable, matching `$`.
 * @param {string} kind
 * @param {string} id
 * @returns {VEl|null}
 */
export const wbEl = (kind, id) => $(id + '_' + kind);

/** Return the height of pinned header and tab chrome in pixels. `--stick-h` is measured by `stickytabs.js`; on short windows it excludes the tab bar when pinning is disabled.
 * @returns {number}
 */
export function stickTop() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stick-h')) || 0;
}

/** Scroll an element below the pinned header and tabs. Use the measured sticky offset rather than `scrollIntoView`, which would place the element behind the chrome. Preserve caller-specific scroll behavior.
 * @param {Element|null} el
 * @param {number} [gap] px of daylight under the bar.
 * @param {ScrollBehavior} [behavior]
 */
export function scrollUnderStick(el, gap = 10, behavior = 'smooth') {
  if (!el) return;
  const stick = stickTop();
  const top = el.getBoundingClientRect().top + window.scrollY - stick - gap;
  window.scrollTo({ top: Math.max(0, top), behavior });
}
