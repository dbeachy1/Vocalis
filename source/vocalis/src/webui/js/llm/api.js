// llm/api.js — LLM ▸ API: a hosted provider's key, and the model the worldbook editor uses (11.1).
//
// This tab stores a hosted provider key, searches available models, and shows progress while a
// connection is tested.
//
// 🔴 THE KEY IS WRITE-ONLY FROM HERE. `/llm/api` answers `key_set`, never the key, so the input is
// always empty after a load and "Key saved" is painted beside it. Nothing in this file may put a
// key into the DOM, UIS or localStorage; the value lives in the input only until Save sends it,
// and Save clears the input on success.
//
// 🔴 THERE IS NO LIST UNTIL SOMETHING IS TYPED. OpenRouter has hundreds of models and Featherless
// about 22,000; a drop-down of either is not a picker. Two characters, a 300 ms pause, then at
// most 50 rows, and a click (or Enter) picks one and saves it — there is no separate Save.
//
// ⚠️ A SLOW SEARCH MUST NOT OVERWRITE A NEWER ONE. Typing `gl` then `glm` sends two requests whose
// answers can land in either order; `searchSeq` lets only the latest paint. Without it the list
// can show `gl`'s rows under a box that says `glm`, which reads as the search being wrong.
//
// WHAT IS EXPORTED — one name.
//
//   apiLoadAll   js/llm/tabs.js, on entering the API sub-tab
import { $, esc } from '../util/dom.js';
import { jget, jpost, jput } from '../util/http.js';
import { wbConfirm } from '../ui/modal.js';
import { UIS } from '../util/uistate.js';
import { engLoad } from './engine.js';

/**
 * One provider as `/llm/api` paints it — `web/llmapi._provider_view()`.
 * @typedef {object} ApiProvider
 * @property {string} id
 * @property {string} label
 * @property {boolean} key_set
 * @property {string} model
 * @property {Record<string, any>} model_meta
 * @property {{ok: boolean, message: string, at: number}|null} last_connect
 */

/**
 * One search row — `llmapi._or_row()` / `_fl_row()`.
 * @typedef {object} ApiModelRow
 * @property {string} id
 * @property {string} name
 * @property {number|null} context_length
 * @property {number|null} [price_in]     USD per million prompt tokens (OpenRouter)
 * @property {number|null} [price_out]
 * @property {string[]} [supported_parameters]
 * @property {string} [model_class]        (Featherless)
 * @property {number|null} [concurrency_cost]
 */

/** Which provider the tab shows. UIS (account-local, vault-stored), like every remembered view. */
const PICK = 'vocalis-llmapi-provider';

/** @type {{providers: ApiProvider[], rows: ApiModelRow[]}} */
const api = { providers: [], rows: [] };
let searchSeq = 0;
/** True for the whole Connect round trip — see the Connect handler. */
let connecting = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let searchTimer = null;

/** @returns {string} */
function current() {
  const sel = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ ($('apiProvider')));
  return sel.value || 'openrouter';
}

/** @returns {ApiProvider|undefined} */
function view() {
  return api.providers.find(p => p.id === current());
}

/** @param {number|null|undefined} n */
function ctx(n) {
  return typeof n === 'number' ? (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)) + ' ctx' : '';
}

/** @param {number|null|undefined} n */
function usd(n) {
  // Cents, except for the sub-cent prices some small models carry, which would all read $0.00.
  return typeof n === 'number' ? '$' + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)) : '?';
}

/**
 * The one-line facts for a row or a pick: context, then price (OpenRouter) or class and
 * concurrency cost (Featherless).
 * @param {Record<string, any>} m
 */
function facts(m) {
  const out = [];
  if (m.context_length) out.push(ctx(m.context_length));
  if (typeof m.price_in === 'number' || typeof m.price_out === 'number') out.push(`${usd(m.price_in)} in / ${usd(m.price_out)} out per M`);
  if (m.model_class) out.push(m.model_class);
  if (typeof m.concurrency_cost === 'number') out.push(`${m.concurrency_cost} concurrency units`);
  return out.join(' · ');
}

/** @param {number} at seconds since the epoch */
function ago(at) {
  const s = Math.max(0, Date.now() / 1000 - at);
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 129600) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}

/** Paint everything for the provider showing. No network. */
function paint() {
  const p = view();
  if (!p) return;
  const key = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($('apiToken')));
  key.placeholder = p.key_set ? 'saved — paste a new key to replace it' : `paste your ${p.label} key`;
  /** @type {VEl} */ ($('apiKeyState')).textContent = p.key_set
    ? `A ${p.label} key is saved (encrypted on this server; it is never shown again).`
    : `No ${p.label} key saved.`;
  /** @type {VEl} */ ($('apiKeyRemove')).style.display = p.key_set ? '' : 'none';
  if (!connecting) /** @type {HTMLButtonElement} */ (/** @type {unknown} */ ($('apiConnect'))).disabled = !p.key_set;
  const cs = /** @type {VEl} */ ($('apiConnectState'));
  if (p.last_connect) {
    cs.textContent = (p.last_connect.ok ? '✓ ' : '✗ ') + p.last_connect.message + ` (checked ${ago(p.last_connect.at)})`;
    cs.className = 'small ' + (p.last_connect.ok ? 'ok' : 'warn');
  } else {
    cs.textContent = p.key_set ? 'Not checked yet — Connect tests the key.' : '';
    cs.className = 'small muted';
  }
  const search = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($('apiSearch')));
  search.disabled = !p.key_set;
  if (!p.key_set) hideResults();
  const sel = /** @type {VEl} */ ($('apiSelected'));
  sel.innerHTML = p.model
    ? `Selected: <b class="mono">${esc(p.model)}</b>` +
      (facts(p.model_meta || {}) ? ` <span class="muted">· ${esc(facts(p.model_meta))}</span>` : '')
    : '<span class="muted">No model picked yet — search above and click one.</span>';
  /** @type {VEl} */ ($('apiPrivacy')).textContent =
    `When the worldbook editor runs on ${p.label}, the text of each field it edits is sent to ${p.label}.`;
}

/** Entering the API sub-tab. */
export async function apiLoadAll() {
  try {
    const want = UIS.getItem(PICK);
    if (want === 'openrouter' || want === 'featherless')
      /** @type {HTMLSelectElement} */ (/** @type {unknown} */ ($('apiProvider'))).value = want;
  } catch (e) {}
  await refresh();
}

async function refresh() {
  try {
    api.providers = (await jget('/llm/api')).providers || [];
  } catch (e) {
    /** @type {VEl} */ ($('apiKeyState')).textContent = 'Could not read the API settings.';
    return;
  }
  paint();
}

function hideResults() {
  const box = /** @type {VEl} */ ($('apiResults'));
  box.style.display = 'none';
  box.innerHTML = '';
  api.rows = [];
  /** @type {VEl} */ ($('apiSearchSpin')).style.display = 'none';
}

async function runSearch() {
  const p = view();
  const q = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($('apiSearch'))).value.trim();
  const st = /** @type {VEl} */ ($('apiSearchState'));
  const seq = ++searchSeq;
  if (!p || q.length < 2) {
    hideResults();
    st.textContent = '';
    return;
  }
  /** @type {VEl} */ ($('apiSearchSpin')).style.display = '';
  st.textContent = '';
  let r;
  try {
    r = await jget(`/llm/api/${encodeURIComponent(p.id)}/models?q=${encodeURIComponent(q)}`);
  } catch (e) {
    if (seq !== searchSeq) return;
    hideResults();
    st.textContent = /** @type {Error} */ (e).message || 'search failed';
    return;
  }
  if (seq !== searchSeq) return; // a newer search owns the box — see the header
  /** @type {VEl} */ ($('apiSearchSpin')).style.display = 'none';
  api.rows = r.models || [];
  const box = /** @type {VEl} */ ($('apiResults'));
  if (!api.rows.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    st.textContent = `No ${p.label} models match “${q}”.`;
    return;
  }
  st.textContent = api.rows.length >= 50 ? 'Showing the first 50 — type more to narrow it.' : '';
  box.innerHTML = api.rows
    .map(
      (m, i) =>
        `<div class="apirow" role="option" tabindex="0" data-i="${i}" title="${esc(m.name || m.id)}">` +
        `<span class="id">${esc(m.id)}</span><span class="facts">${esc(facts(m))}</span></div>`,
    )
    .join('');
  box.style.display = '';
}

/** @param {number} i index into `api.rows` */
async function pick(i) {
  const p = view();
  const row = api.rows[i];
  if (!p || !row) return;
  // A search still in flight (or still debouncing) must not repaint its rows under the box this
  // click is about to close (sequence guard) — the same sequence guard the header describes.
  searchSeq++;
  if (searchTimer) clearTimeout(searchTimer);
  try {
    await jput(`/llm/api/${encodeURIComponent(p.id)}/model`, { id: row.id, meta: row });
  } catch (e) {
    /** @type {VEl} */ ($('apiSearchState')).textContent = 'Could not save the pick: ' + /** @type {Error} */ (e).message;
    return;
  }
  /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($('apiSearch'))).value = '';
  /** @type {VEl} */ ($('apiSearchState')).textContent = '';
  hideResults();
  await refresh();
  engLoad();
}

/** @type {VEl} */ ($('apiProvider')).addEventListener('change', () => {
  try {
    UIS.setItem(PICK, current());
  } catch (e) {}
  /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($('apiSearch'))).value = '';
  /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($('apiToken'))).value = '';
  /** @type {VEl} */ ($('apiSearchState')).textContent = '';
  searchSeq++;
  hideResults();
  paint();
});

/** @type {VEl} */ ($('apiKeySave')).addEventListener('click', async () => {
  const p = view();
  const input = /** @type {HTMLInputElement} */ (/** @type {unknown} */ ($('apiToken')));
  const key = input.value.trim();
  if (!p || !key) return;
  try {
    await jput(`/llm/api/${encodeURIComponent(p.id)}/key`, { api_key: key });
  } catch (e) {
    /** @type {VEl} */ ($('apiKeyState')).textContent = 'Could not save the key: ' + /** @type {Error} */ (e).message;
    return;
  }
  input.value = '';
  await refresh();
  engLoad();
});

/** @type {VEl} */ ($('apiKeyRemove')).addEventListener('click', async () => {
  const p = view();
  if (!p) return;
  const ok = await wbConfirm(
    `Remove the ${esc(p.label)} key?`,
    `The worldbook editor will not be able to use ${esc(p.label)} until a key is saved again.`,
    'Remove',
    true,
  );
  if (!ok) return;
  try {
    await jput(`/llm/api/${encodeURIComponent(p.id)}/key`, { api_key: '' });
  } catch (e) {
    /** @type {VEl} */ ($('apiKeyState')).textContent = 'Could not remove the key: ' + /** @type {Error} */ (e).message;
    return;
  }
  await refresh();
  engLoad();
});

// 🔴 THE SPINNER IS THE FEATURE (R6). The button disables and carries the spinner for the whole
// round trip — the server allows 30 s — so a second click cannot stack a second check, and a
// silent ten-second wait never looks like a dead button.
// ⚠️ `connecting` IS WHAT `paint()` RESPECTS (connection-state guard). Without it, any repaint during the
// round trip — a key save, a provider switch — set `disabled = !key_set` and re-enabled the
// spinning button, so a second Connect could stack. Save key, Remove and the provider switch are
// held for the same span: a key changed mid-check would otherwise be judged by the old key's answer
// (the server discards that verdict too — `key_gen` — but the UI should not invite it).
/** @type {VEl} */ ($('apiConnect')).addEventListener('click', async () => {
  const p = view();
  if (!p || connecting) return;
  const btn = /** @type {HTMLButtonElement} */ (/** @type {unknown} */ ($('apiConnect')));
  const cs = /** @type {VEl} */ ($('apiConnectState'));
  connecting = true;
  holdKeyControls(true);
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Connecting…';
  cs.textContent = `Asking ${p.label}…`;
  cs.className = 'small muted';
  try {
    await jpost(`/llm/api/${encodeURIComponent(p.id)}/connect`);
  } catch (e) {
    cs.textContent = 'Connect failed: ' + /** @type {Error} */ (e).message;
    cs.className = 'small warn';
  } finally {
    connecting = false;
    holdKeyControls(false);
    btn.textContent = 'Connect';
    btn.disabled = false;
  }
  await refresh();
});

/** @param {boolean} on */
function holdKeyControls(on) {
  for (const id of ['apiKeySave', 'apiKeyRemove', 'apiProvider'])
    /** @type {HTMLButtonElement} */ (/** @type {unknown} */ ($(id))).disabled = on;
}

/** @type {VEl} */ ($('apiSearch')).addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});

/** @type {VEl} */ ($('apiResults')).addEventListener('click', e => {
  const row = /** @type {HTMLElement} */ (e.target).closest('.apirow');
  if (row) pick(Number(/** @type {HTMLElement} */ (row).dataset.i));
});

/** @type {VEl} */ ($('apiResults')).addEventListener('keydown', e => {
  const row = /** @type {HTMLElement} */ (e.target).closest('.apirow');
  if (row && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    pick(Number(/** @type {HTMLElement} */ (row).dataset.i));
  }
});
