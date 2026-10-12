// llm/engine.js — "Worldbook editor uses: [ … ]" at the top of the LLM tab (11.1).
//
// Which engine the Character & Worldbook editor runs its passes on: llama.cpp, KoboldCpp,
// OpenRouter or Featherless. The server decides everything that matters (`/llm/engine` for the
// choice and what is usable, `/wbedit/model` for what a pass would actually run on); this file
// only paints the two answers and sends a change.
//
// 🔴 THE READOUT IS `/wbedit/model`, THE SAME ROUTE THE WORLDBOOK TAB'S BADGE READS. Both go
// through `llm_engine.resolve()` server-side, so the LLM tab and the worldbook tab cannot disagree
// about which model a pass will use — which is the whole reason the record carries a model (§3.1).
//
// ⚠️ A DISABLED OPTION CAN STILL BE THE SELECTED ONE. If a provider key is removed, keep the
// current choice and show why it is unavailable rather than silently switching engines.
//
// WHAT IS EXPORTED — two names, each with a named caller.
//
//   engLoad     js/llm/tabs.js on entering the LLM tab; js/llm/api.js after a key or pick changes
//   engModel    engLoad, and the drop-down's change handler
import { $, esc } from '../util/dom.js';
import { jget, jput } from '../util/http.js';

/**
 * One row of `/llm/engine`'s `engines`.
 * @typedef {object} EngineOption
 * @property {string} id       'llama' · 'kobold' · 'openrouter' · 'featherless'
 * @property {string} label
 * @property {boolean} usable  false when a configuration is missing (URL, key, picked model)
 * @property {string} reason   what is missing, for the option text
 */

/** Guards the readout against a slow answer landing after a newer one. */
let modelSeq = 0;

/** Paint the drop-down from `/llm/engine`, then the model readout. */
export async function engLoad() {
  const sel = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ ($('llmEngine')));
  let r;
  try {
    r = await jget('/llm/engine');
  } catch (e) {
    /** @type {VEl} */ ($('llmEngineModel')).textContent = 'could not read the engine setting';
    return;
  }
  sel.innerHTML = /** @type {EngineOption[]} */ (r.engines)
    .map(
      o =>
        `<option value="${esc(o.id)}"${o.usable ? '' : ' disabled'}>${esc(o.label)}` + `${o.usable ? '' : ' — ' + esc(o.reason)}</option>`,
    )
    .join('');
  sel.value = r.engine;
  engModel();
}

/** Ask `/wbedit/model` what a pass would run on right now, and say it beside the drop-down. */
export async function engModel() {
  const el = /** @type {VEl} */ ($('llmEngineModel'));
  const seq = ++modelSeq;
  el.textContent = 'checking…';
  el.className = 'muted';
  let m;
  try {
    m = await jget('/wbedit/model');
  } catch (e) {
    if (seq === modelSeq) el.textContent = '';
    return;
  }
  if (seq !== modelSeq) return;
  if (m.loaded && m.model) {
    el.textContent = 'model: ' + m.model;
    el.className = '';
  } else {
    // KoboldCpp's badge has always said "no model loaded"; the other engines have a reason worth
    // reading (no key, nothing picked, two llama.cpp models held), so they say it.
    el.textContent = m.engine === 'kobold' || !m.error ? 'no model loaded' : m.error;
    el.className = 'warn';
  }
}

/** @type {VEl} */ ($('llmEngine')).addEventListener('change', async () => {
  const sel = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ ($('llmEngine')));
  const want = sel.value;
  try {
    await jput('/llm/engine', { engine: want });
  } catch (e) {
    /** @type {VEl} */ ($('llmEngineModel')).textContent = 'could not save the engine setting';
  }
  engLoad();
});
