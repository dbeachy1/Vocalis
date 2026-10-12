// llm/tabstate.js — WHICH LLM sub-tab is showing, and nothing else (9.5-m1).
//
// 🔴 A DIRECT COPY OF `js/st/tabstate.js`'S SHAPE, DELIBERATELY, AND THE THREE THINGS IT LEARNED
// THE HARD WAY ARE THE THREE THINGS THIS FILE EXISTS FOR:
//
//   1. **THE LIST IS READ OFF THE STRIP, NEVER HAND-LISTED.** A stale allow-list rejects newly
//      added tabs on reload and silently falls back to the default. Deriving it from the strip
//      ensures every visible sub-tab can be restored.
//
//   2. **`UIS`, NOT `localStorage`.** The UIS boot block sweeps every `vocalis-*` key out of
//      localStorage except the two in CLIENT_ONLY, and it runs long before this line — so a value
//      written to localStorage here would be deleted before it was ever read. That is the bug that
//      made the ST sub-tab never restore, and it failed silently: the read just returned null and
//      the default won.
//
//   3. **THE `let` IS NOT EXPORTED.** `Object.assign(window, mod)` copies a value ONCE at module
//      load, so a published `let` is frozen at its initial value while the real one moves. A
//      browser spec polling it would never see a click land and would time out blaming the tab.
//      `llmTabNow()` reads it; `llmTabSet()` writes it WITHOUT running the switch, which is what
//      the boot migration needs (see js/main.js — painting a pane inside a section that is still
//      hidden is not the same as remembering which pane to open).
//
// ⚠️ IMPORTS EXACTLY ONE LEAF (`util/uistate.js`), so nothing that imports this can cycle through
// it. That property rests on uistate.js staying import-free — st/tabstate.js's header records that
// the same sentence there was WRONG for a while after 7.3-m13 added an import to it. Re-derive
// before trusting it.
import { UIS } from '../util/uistate.js';

/**
 * The sub-tabs, in DOM order. First is the default for a browser that has never been here.
 * 🔴 llama.cpp is first, so the left-most tab is also the default for a fresh browser. Keep that
 * ordering in mind when reordering the strip.
 * @type {string[]}
 */
export const LLM_TABS = [...document.querySelectorAll('#llmTabs button')].map(
  b => /** @type {HTMLElement & { dataset: { llmtab: string } }} */ (b).dataset.llmtab,
);

let llmTab = LLM_TABS[0] || 'llama';
try {
  const t = UIS.getItem('vocalis-llmtab');
  if (/** @type {(string | null)[]} */ (LLM_TABS).includes(t)) llmTab = /** @type {string} */ (t);
} catch (e) {}

/** The sub-tab showing right now. A function, because the `let` above is reassigned. */
export function llmTabNow() {
  return llmTab;
}

/**
 * Remember a sub-tab WITHOUT painting it. The boot migration's door — see js/main.js.
 * @param {string} name
 */
export function llmTabSet(name) {
  llmTab = name;
  try {
    UIS.setItem('vocalis-llmtab', name);
  } catch (e) {}
}
