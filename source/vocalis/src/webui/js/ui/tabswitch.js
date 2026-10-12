// tabswitch.js — the tab bar's MECHANISM, with no idea what any tab contains (7.5.6).
//
// 🔴 THIS FILE EXISTS TO BREAK A CYCLE, AND THE CYCLE WAS LOAD-BEARING IN THE WORST WAY.
// `ui/tabs.js` imports a loader from twelve feature modules so `switchTab` can call the right one
// on entry; five of those modules imported `switchTab` straight back. That mutual edge — plus nine
// more like it — made `src/webui/js` ONE strongly-connected component of 18 modules.
//
// Why that stopped being academic at 7.5.6: the page moved to a bundle
// (tools/build_webui.mjs), and a bundler has to LINEARIZE the graph. Outside a cycle there is one
// legal order and everybody agrees on it. INSIDE a cycle there is not, and the browser cuts it
// where it first entered while esbuild cuts it dependency-first — so 62 of 65 modules evaluated at
// a different position, and since nearly every module here wires its DOM at module-eval, one of
// them painted into an element another had not created yet. `clips_train_browser_spec.mjs` failed
// 3 runs in 5 with "Cannot set properties of null (setting 'innerHTML')".
//
// ⚠️ THE CODE WAS ALREADY FRAGILE AND THE BUNDLE ONLY REVEALED IT. The old order was not chosen,
// it was whatever the browser's cycle-cutting happened to produce. Anything that perturbed it —
// a new import edge, a file rename, a different browser — could have produced the same failure at
// any time, with no bundler anywhere near it.
//
// 📌 WHAT REPLACES THE IMPORT IS REGISTRATION, WHICH POINTS THE OTHER WAY. This module knows how to
// mark a button active and show a panel. It does not know that `voices` has a list to load, and it
// must never learn: the moment it imports a feature to call it, the cycle is back. `ui/tabs.js`
// owns that knowledge and hands it over with `onTabSwitch`.
//
// ⚠️ REGISTRATION IS STILL ORDERING, JUST FAR WEAKER ORDERING. Handlers have to be registered
// before the first switch, not before some other module's body. `ui/tabs.js` registers at
// module-eval and js/main.js's boot IIFE is the first caller, so the gap is closed by the entry
// point rather than by luck. A `switchTab` that runs with nothing registered moves the highlight
// and paints the panel — it does not throw, and that is deliberate: a half-wired page the user can
// still navigate beats a dead one.
import { UIS } from '../util/uistate.js';

/** @type {((name: string) => void)[]} */
const _handlers = [];

/**
 * Register `fn(name)`, called after every switch has painted. `ui/tabs.js` is the only caller.
 * @param {(name: string) => void} fn
 */
export function onTabSwitch(fn) {
  _handlers.push(fn);
}

/** @param {string} name */
export function switchTab(name) {
  try {
    UIS.setItem('vocalis-tab', name);
  } catch (e) {} // survive a reload on the same tab
  // #tabs only — '.tabs button' would also hit the Voice Studio and Book SUB-tab bars
  // (they share the .tabs class) and strip their active highlight on every switch.
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#tabs button')).forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name),
  );
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('section[data-panel]')).forEach(
    s => (s.style.display = s.dataset.panel === name ? '' : 'none'),
  );
  // 🔴 PAINT FIRST, THEN THE HANDLERS. A loader that throws must not leave the user on a tab that
  // never opened — the panel is already visible and the highlight already moved by this line.
  // ⚠️ And one bad handler must not cost the others: the dispatch this replaced was a straight run
  // of `if` statements where the first throw skipped every stop-polling call after it.
  for (const fn of _handlers) {
    try {
      fn(name);
    } catch (e) {
      console.error('tab handler failed for ' + name, e);
    }
  }
}
