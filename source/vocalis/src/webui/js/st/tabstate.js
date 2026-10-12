// st/tabstate.js — WHICH SillyTavern sub-tab is showing, and nothing else (7.3-m2b).
//
// 🔴 SIXTEEN LINES, ONE `let`, AND IT IS THE m8a MOVE FOR THE SECOND TIME: shared state belongs to
// none of the features that read it, and taking it out separately is what stops the module graph
// growing cycles. `js/voice/design.js` was the first (`vc`, shared by three pieces of the Create
// tab); this is the second, and here the cycles were not hypothetical — they were the reason.
//
// FOUR MODULES ASK WHICH SUB-TAB IS SHOWING, AND ONE WRITES IT BEFORE THE ROUTER EXISTS:
//
//   js/st/tabs.js      `switchStTab` sets it on every switch                     (stTabSet)
//   js/ui/tabs.js      `switchTab`'s `if(name==='sillytavern')` reopens it       (stTabNow)
//   js/st/chars.js     `stCharsOpen()` asks whether its own pane is visible      (stTabNow)
//   js/wb/open.js      `if(stTab === kind) wbLoadLib(kind)` — still looking?     (stTabNow)
//   js/main.js         the saved-`clips`-tab migration writes it at boot         (stTabSet)
//
// 🔴 PUT `stTab` IN THE ROUTER AND EVERY ONE OF THOSE BECOMES A CYCLE, because the router imports
// from `st/chars.js`, `st/log.js`, `scenes/scenes.js` and `wb/open.js` in order to dispatch to them.
// ES modules tolerate a cycle when every use is inside a function — and all of these are — but 7.1
// §5.8 settled that a cycle between two modules is usually a filing error, and FOUR of them is not
// a borderline call. **This file imports exactly one leaf, so nothing it is imported by can cycle
// through it.** ⚠️ It imports `util/uistate.js`, which must remain import-free. The
// property that matters rests on uistate.js being import-free rather than on
// this file being import-free, and that is a weaker claim resting on a different file: if
// util/uistate.js ever grows an import, re-derive this before trusting it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 `stTab` ITSELF IS NOT EXPORTED, AND THAT IS THE POINT OF THE TWO ACCESSORS.
//
// It is a `let` that `switchStTab` reassigns, and `Object.assign(window, mod)` copies a value ONCE at
// module load (§11.4's third row). `tests/wbedit_browser_spec.mjs` polls the current sub-tab at three
// points to prove a click landed; against a frozen copy those polls never become true and the spec
// times out blaming the editor. So:
//
//   stTabNow()      read it. Cannot go stale, which a published `let` silently would.
//   stTabSet(name)  write it WITHOUT running the switch. ⚠️ NOT the same thing as `switchStTab`:
//                   js/main.js's boot migration turns a saved top-level `clips` tab into
//                   SillyTavern ▸ Clips by remembering the sub-tab and then letting the ordinary
//                   `switchTab('sillytavern')` open it a few lines later. Calling `switchStTab`
//                   there would paint and load a pane inside a section that is still hidden.
//
// 📌 m11b's `stPollRunning`/`stFacesNow` and m7's `scLib` are the same rule from both ends: publish a
// FUNCTION over mutable state, never the state; publish a `const` that is only mutated, never a `let`.
//
// ⚠️ `ST_TABS` IS EXPORTED AS THE ARRAY, and that is safe for exactly the reason `stTab` is not: it is
// a `const` the code only ever reads. One browser spec reads it to prove the strip and the
// allow-list agree.
//
// ⚠️ `UIS` is read as a bare inline global, which a module may do (the classic script's top-level
// declarations are in the global declarative record and it always runs first). §11.2 canceled
// `util/uistate.js`, so that reach is permanent, not a to-do.

// 🔴 READ OFF THE STRIP, NEVER HAND-LISTED. This was `['logs','characters','clips']` and stayed
// that way while 7.0 added Character Cards, World Books and Personas — so `switchStTab` faithfully
// SAVED 'cards', and this line then rejected it as unknown on the next load and fell back to Logs.
// Without deriving the list, tabs added later could be saved but rejected on reload, silently
// falling back to Logs.
// Deriving it means a sub-tab cannot be added without being restorable. (The buttons are parsed
// long before this inline block runs — the strip is at the top of the document.)
import { UIS } from '../util/uistate.js'; // 7.3-m13: was a bare inline global

export const ST_TABS = [...document.querySelectorAll('#stTabs button')].map(
  b => /** @type {HTMLElement & { dataset: { sttab: string } }} */ (b).dataset.sttab,
);
let stTab = 'logs';
// 🔴 UIS, NOT localStorage — 6.2. The UIS
// block (index.html:1577) sweeps EVERY `vocalis-*` key out of localStorage on boot, except the
// two in CLIENT_ONLY, because the ship gate is "localStorage holds only theme and volume". It
// runs long before this line, so the value written below had already been deleted by the time
// it was read, every single load. Nothing failed, nothing threw — the read just returned null
// and the default won. ⚠️ Grep for `localStorage.setItem('vocalis-` before adding another one.
try {
  const t = UIS.getItem('vocalis-sttab');
  if (/** @type {(string | null)[]} */ (ST_TABS).includes(t)) stTab = /** @type {string} */ (t);
} catch (e) {}

/** The sub-tab showing right now. A function, because the `let` below is reassigned. */
export function stTabNow() {
  return stTab;
}

/**
 * Remember a sub-tab WITHOUT switching to it — see the header on why that is not `switchStTab`.
 * @param {string} name
 */
export function stTabSet(name) {
  stTab = name;
}

// ── switching, as a subscription (7.5.6) ────────────────────────────────────────────────────
// 🔴 THE DISPATCHER LIVES HERE AND THE BEHAVIOR LIVES IN st/tabs.js, to break a cycle. That file
// imports `loadScenes` from js/scenes/scenes.js so the Clips pane fills when it opens, and
// scenes.js imported `switchStTab` straight back for ✎ Apply's return trip. Mutual, and one of the
// strands of the 18-module strongly-connected component that bundled in an order the browser never
// used (see js/ui/tabswitch.js for the full argument — this is the same cut, one level down).
//
// ⚠️ THE NAME LIVES HERE NOW, AND ONLY HERE. `_websrc.mjs`'s spec surface publishes both this
// module and st/tabs.js onto the same `window`, so if both exported `switchStTab` the second
// `Object.assign` would silently win. st/tabs.js's implementation is `stTabApply` for that reason.
// 📌 A no-op default, so a switch before st/tabs.js has evaluated does nothing rather than throwing.
// The `@type` is what carries the argument: written bare, the no-op stub is 0-arity and both the
// registration and the call below go unchecked (TS2554). Same shape, same reason, as voice/vtbus.js.
/** @type {(name: string) => void} */
let _apply = () => {};
/** @param {(name: string) => void} fn */
export function onStTabSwitch(fn) {
  _apply = fn;
}
/** @param {string} name */
export function switchStTab(name) {
  _apply(name);
}
