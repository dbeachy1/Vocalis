// llm/tabs.js — the LLM sub-tab router (9.5-m1).
//
// Paints the strip, shows one pane, and starts/stops the right poller. Separated from
// `llm/tabstate.js` for the reason 7.1 §5.8 settled and `js/st/tabstate.js` records: this file
// imports both engines' loaders in order to dispatch to them, so putting the shared `llmTab`
// state here would make every reader of that state a cycle through the router.
//
// 🔴 **THE STOP HALF IS NOT OPTIONAL, AND IT IS WHY THESE ARE SUB-TABS AT ALL.** Each engine
// panel owns a live poller against a model server. Leaving one running while its pane is hidden
// means polling a server nobody is looking at — forever, because nothing else stops it. That is
// the invariant `js/ui/tabs.js` exists to keep visible for the TOP-level bar, and it applies one
// level down unchanged. Two cards on one page could not have this property at all: both pollers
// would run whenever the tab was open, and one of the two engines is usually unconfigured.
//
// 📌 ORDER INSIDE THE DISPATCH MATTERS, the same way it does in `js/ui/tabs.js`: the entering
// load runs BEFORE the leaving stops, so `if (name !== 'kobold') kobPollStop()` cannot stop a
// poll that `kobLoadAll()` just started.
import { $ } from '../util/dom.js';
import { llmTabNow, llmTabSet } from './tabstate.js';
import { kobLoadAll, kobPollStop } from '../sys/kobold.js';
import { llaLoadAll, llaPollStop } from '../sys/llama.js';
import { apiLoadAll } from './api.js'; // 11.1 - LLM ▸ API. No poller: nothing to stop on leave.
import { engLoad } from './engine.js'; // 11.1 - "Worldbook editor uses", above the strip

/**
 * Show one LLM sub-tab: paint the strip, swap the panes, run the enter/leave pair.
 * @param {string} name
 */
export function switchLlmTab(name) {
  llmTabSet(name);
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#llmTabs button')).forEach(b =>
    b.classList.toggle('active', b.dataset.llmtab === name),
  );
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-llmpanel]')).forEach(
    s => (s.style.display = s.dataset.llmpanel === name ? '' : 'none'),
  );
  if (name === 'llama') llaLoadAll();
  if (name === 'kobold') kobLoadAll();
  if (name === 'api') apiLoadAll();
  if (name !== 'llama') llaPollStop();
  if (name !== 'kobold') kobPollStop();
}

/**
 * Entering the LLM tab: open whichever sub-tab was last showing. Called by `js/ui/tabs.js`.
 * ⚠️ NOT the same as calling `switchLlmTab` at module-eval — at that point the section is still
 * `display:none` and its loaders would run against a pane nobody can see.
 */
export function llmLoadAll() {
  engLoad();
  switchLlmTab(llmTabNow());
}

/** Leaving the LLM tab: both pollers stop. Neither engine is being looked at. */
export function llmPollStop() {
  llaPollStop();
  kobPollStop();
}

// ⚠️ REGISTERED AT MODULE-EVAL, like `#bkTabs`'s listener in js/ui/tabs.js, and safe for the same
// reason: the LLM section ships `style="display:none"`, so the strip cannot be clicked until
// `switchTab('llm')` has run — which is after the module graph by construction.
/** @type {VEl} */ ($('llmTabs')).addEventListener('click', e => {
  const t = /** @type {HTMLElement} */ (e.target).dataset.llmtab;
  if (t) switchLlmTab(t);
});
