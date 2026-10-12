// sys/llama.js — the llama.cpp sub-tab and its ⚙ Settings panel (9.5-m1).
//
// A remote control for a model server Vocalis does not own: say what is loaded, and (from m2)
// load and unload it. Read-only at m1.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// Three route contracts are easy to misread from llama.cpp state alone; DESIGN_9_5 §2f records
// the supporting router behavior.
//
//   1. **"Loaded" means HOLDING VRAM, not `is_running()`.** With `--sleep-idle-seconds` a model
//      goes `sleeping`: the router still routes to it, it still reads as running, and it holds
//      NOTHING. `/llama/status` already draws that line (`holds_vram`); painting `running` as
//      loaded would report a model sitting on cards that are empty.
//
//   2. **A 404 from llama-server does not say what went wrong.** httplib overwrites every 404
//      body with a generic "File Not Found", so unknown-model, wrong-URL and not-a-router are one
//      response. The server side turns that into a sentence naming all three; this file must
//      render THAT and never re-quote a server string it did not compose.
//
//   3. **"Not configured" and "configured but down" are different states.** `/llama/info` reports
//      them as separate fields. Collapsing them into one "unavailable" card would suggest a URL
//      change even when the configured endpoint is correct.
//
// ⚠️ AND ONE THING THE TAB MUST NOT IMPLY: a single-model `llama-server` is NOT broken. It was
// started with `-m`, it is serving, and it simply has no model-management API. `#llaSingle` says
// what to change if he wants load/unload; it is not an error card and must not be styled as one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — three names, each with a named caller.
//
//   llaLoadAll · llaPollStop     js/llm/tabs.js, on entering and leaving the llama.cpp sub-tab
//   llaRenderSettings            loadAppSettings, which paints the ⚙ panel from /settings/app
import { $, esc } from '../util/dom.js';
import { jget, jput, jpost } from '../util/http.js';
import { switchTab } from '../ui/tabswitch.js';
import { modal } from '../ui/modal.js'; // 9.5-m2 - the confirm before a load or unload
import { UIS } from '../util/uistate.js'; // 9.5.20 - which model the drop-down opens on
import { DOCKER } from './modelstate.js'; // the Docker-package flag, from /health

/**
 * One row of `/llama/models` — `llama._row()` server-side.
 * @typedef {object} LlamaModelRow
 * @property {string} id
 * @property {string[]} aliases
 * @property {string[]} tags
 * @property {string} status      'unloaded'·'loading'·'loaded'·'sleeping'·'downloading'·'downloaded'
 * @property {boolean} running    llama.cpp's own `is_running()` — INCLUDES `sleeping`.
 * @property {boolean} holds_vram `loaded` only. The one to paint as "on the cards".
 * @property {string} source      'models_dir'·'preset'·'cache' — the LITERAL strings it sends.
 * @property {boolean} failed     `unloaded` WITH a non-zero exit code: a crashed load.
 * @property {number} [exit_code]
 * @property {string[]} args      the argv the child was spawned with
 * @property {string} [preset]    the INI section, re-rendered by the router
 * @property {LlamaMeta} [meta]   n_ctx / n_ctx_train / n_params / size / ftype, once running
 */

/** @type {{info: any, status: any, models: LlamaModelRow[], timer: any}} */
const lla = { info: null, status: null, models: [], timer: null };

/**
 * The last model choice uses account-local UI state in the vault, so it survives refreshes and
 * server restarts. `localStorage` is cleared for `vocalis-*` keys except `CLIENT_ONLY`; see the
 * shared UI-state policy and `js/llm/tabstate.js`.
 */
const LLA_PICK = 'vocalis-lla-model';

/**
 * Which models were holding VRAM at the previous poll. `null` until the first one has landed —
 * the two cases are genuinely different, which is what the branch in `noteHeld` is about.
 * @type {Set<string>|null}
 */
let heldSeen = null;

/** Record a model that transitions to holding VRAM as the latest load. On initial observation, record a pick only when the resident model is unambiguous.
 * @param {string[]} ids
 */
function noteHeld(ids) {
  if (heldSeen === null) {
    if (ids.length === 1) rememberPick(ids[0]);
  } else {
    for (const id of ids) if (!heldSeen.has(id)) rememberPick(id);
  }
  heldSeen = new Set(ids);
}

/**
 * Record a pick, and NEVER write the same one twice.
 *
 * 🔴 THE GUARD IS NOT TIDINESS. `paint()` calls this from a 4 s poll, so an unguarded
 * `setItem` would POST `/ui-state` every four seconds for as long as the tab is open — a write
 * amplification into the vault that nothing on screen would ever show.
 * @param {string} id
 */
function rememberPick(id) {
  if (!id || UIS.getItem(LLA_PICK) === id) return;
  UIS.setItem(LLA_PICK, id);
}

/**
 * The child's own `/v1/models` metadata, merged in by the router once a model is running.
 * Absent while unloaded, which is honest rather than a gap — nothing has been read off the GGUF.
 * @typedef {object} LlamaMeta
 * @property {number} [n_ctx]        context AS LOADED
 * @property {number} [n_ctx_train]  what the model was trained for
 * @property {number} [n_params]
 * @property {number} [size]         on-disk bytes
 * @property {string} [ftype]        e.g. 'IQ4_XS - 4.25 bpw'
 */

/**
 * Bytes -> a short human string. Sizes here are tens of GB, so one decimal is plenty.
 * @param {number|string} n
 */
function gb(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return '';
  return (v / 1073741824).toFixed(1) + ' GB';
}

/**
 * Parameter counts -> "110.5 B". Same reasoning: nobody reads 110468824832.
 * @param {number|string} n
 */
function params(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return '';
  return v >= 1e9 ? (v / 1e9).toFixed(1) + ' B' : Math.round(v / 1e6) + ' M';
}

/**
 * The badge for one model's state. 🔴 `sleeping` gets its OWN word — it is neither loaded nor
 * unloaded, and calling it either one is a lie about the cards. See the header, item 1.
 * @param {LlamaModelRow} m
 */
function badge(m) {
  if (m.failed) return `<span class="small" style="color:var(--bad)">✖ failed to load (exit ${esc(String(m.exit_code))})</span>`;
  if (m.status === 'loaded') return '<span class="small" style="color:var(--ok)">● loaded</span>';
  if (m.status === 'sleeping') return '<span class="small muted">💤 sleeping — reloads on the next request</span>';
  if (m.status === 'loading') return '<span class="small">⏳ loading…</span>';
  if (m.status === 'downloading') return '<span class="small">⬇ downloading…</span>';
  return '<span class="small muted">○ not loaded</span>';
}

/**
 * The detail line for the SELECTED model — KoboldCpp's `#kobDetail`, same shape, same place.
 *
 * Show only the selected model, not the full preset and model list. The router
 * offers every preset AND every file under its models directory, so the list was ninety-odd rows
 * of things he had not asked about. The drop-down already names them; this says what the one he
 * is looking at is.
 *
 * ⚠️ THE BADGE STAYS, AND IT IS ABOUT THE SELECTED MODEL, not the loaded one. The status box
 * below only ever reports what is holding the cards — so without this, picking a model that
 * crashed on its last load, or one that is `sleeping`, would look identical to picking a fresh
 * one. `sleeping` in particular is running-and-holding-nothing (header, item 1).
 *
 * ⚠️ `meta` ARRIVES ONLY ONCE A MODEL HAS RUN — the router merges the child's own `/v1/models`
 * in, and there is nothing to merge for a model that has never been started. For those, `source`
 * is genuinely all there is to say, and saying it beats inventing a ctx nobody has read.
 */
function renderDetail() {
  const el = $('llaDetail');
  if (!el) return;
  const sel = /** @type {HTMLSelectElement} */ ($('llaSel'));
  const m = lla.models.find(x => x.id === (sel && sel.value));
  if (!m) {
    el.innerHTML = lla.models.length ? '—' : 'llama-server is not offering any models.';
    return;
  }
  const bits = [];
  if (m.meta) {
    if (m.meta.n_ctx) {
      // Show n_ctx as loaded alongside the model's training context; either value alone is
      // insufficient for comparison.
      const trained = m.meta.n_ctx_train ? ` of ${Number(m.meta.n_ctx_train).toLocaleString()}` : '';
      bits.push(`ctx ${Number(m.meta.n_ctx).toLocaleString()}${trained}`);
    }
    if (m.meta.n_params) bits.push(params(m.meta.n_params));
    if (m.meta.size) bits.push(gb(m.meta.size));
    if (m.meta.ftype) bits.push(esc(String(m.meta.ftype)));
  }
  if (!bits.length && m.source) bits.push(esc(m.source));
  el.innerHTML = badge(m) + (bits.length ? ` · ${bits.join(' · ')}` : '');
}

/**
 * Which model an Unload click acts on — ONE function, called by the paint AND by the click, so
 * the button's tooltip and the button's effect cannot drift apart. A rule written out twice is a
 * rule that eventually disagrees with itself, and the disagreement is invisible until the click.
 *
 * 🔴 IT ACTS ON WHAT IS HELD, NOT ON WHAT IS SELECTED, except when the selected model is
 * itself held. Those diverge the moment the drop-down is opened to pick something else, and
 * unloading the model he is about to switch TO is a click that does the opposite of what it says.
 *
 * 🔴 AND `holds_vram` IS A SET, NOT A SINGLETON. `--models-max` defaults to 4, so the router
 * can have several models resident at once; the first version of this read `rows.find(...)` and so
 * offered Load for a model that was already in, and pointed Unload at a DIFFERENT resident model,
 * on a server that allows more than one resident model.
 */
function unloadTarget() {
  const held = lla.models.filter(m => m.holds_vram);
  if (!held.length) return '';
  const sel = /** @type {HTMLSelectElement} */ ($('llaSel'));
  const picked = sel ? sel.value : '';
  return held.some(m => m.id === picked) ? picked : held[0].id;
}

/**
 * Fill the drop-down and decide which buttons exist.
 *
 * 🔴 **TWO BUTTONS, NEVER ONE THAT CHANGES ITS VERB, AND LOAD GOES QUIET FOR A MODEL THAT IS
 * ALREADY IN.** The KoboldCpp tab previously showed
 * "● Loaded" beside a live **Load** button, offering to re-load what was already there. With a
 * model resident there are two DIFFERENT things you might want -- swap it, or free the cards --
 * and one button can only offer one.
 *
 * ⚠️ SELECTING a different model still offers Load, because that is a SWAP and it is a real
 * thing to want. It gets the same confirm as an unload, because it unloads first: same
 * consequence, so not the quiet path to the same place.
 *
 * ⚠️ Neither button exists outside router mode -- there is no route to call, and `#llaSingle`
 * already says why. A button that 409s is not a feature.
 *
 * 📌 The selection is PRESERVED across the 4 s poll. Rewriting the options every poll would
 * otherwise reset the drop-down while the user is reading it.
 *
 * 🔴 **AND IT IS PRESERVED ACROSS A PAGE LOAD, BY THE LAST PICK BEATING WHAT IS RESIDENT.** This
 * drop-down is an INPUT, not a status read-out — `#llaStatus` below is what says which models are
 * actually on the cards — and an input that forgets what you set it to is a bug. Until 9.5.20 the
 * chain was `held[0] || rows[0]`, so the moment nothing was holding the cards (llama-server
 * restarted, Vocalis restarted, an idle model slept and was dropped) the panel came back on
 * whatever the router happened to list first, so the last selected model had to be re-found on
 * every refresh. Use the same rule and server-side store as
 * `vocalis-kob-cfg` on the KoboldCpp tab.
 *
 * ⚠️ ONLY A MODEL THE ROUTER STILL OFFERS. A remembered id that has since been renamed, deleted or
 * dropped from the preset file falls through to the old chain — never a `sel.value` naming a row
 * that is not in the list, which is a select that renders EMPTY rather than one that is wrong.
 */
function paintPicker() {
  const sel = /** @type {HTMLSelectElement} */ ($('llaSel'));
  const loadBtn = $('llaLoad');
  const unloadBtn = $('llaUnload');
  if (!sel || !loadBtn || !unloadBtn) return;
  const router = (lla.status || {}).mode === 'router';
  const rows = lla.models;
  const held = rows.filter(m => m.holds_vram);
  const busy = rows.some(m => m.status === 'loading' || m.status === 'downloading');

  // Keep what he picked THIS page-load, then what he picked LAST time, then a model that is
  // holding the cards, then the first row.
  const pick = UIS.getItem(LLA_PICK);
  const remembered = pick && rows.some(m => m.id === pick) ? pick : '';
  const want = sel.value || remembered || (held[0] && held[0].id) || (rows[0] && rows[0].id) || '';
  const opts = rows.map(m => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');
  if (sel.innerHTML !== opts) sel.innerHTML = opts;
  if (want && sel.value !== want) sel.value = want;

  const picked = sel.value;
  const pickedIsHeld = held.some(m => m.id === picked);
  // Load is ABSENT for the model already in, not disabled: a grayed button still says the
  // action exists. Mid-flight neither verb is honest, so both go.
  loadBtn.style.display = router && !busy && !pickedIsHeld ? '' : 'none';
  unloadBtn.style.display = router && !busy && held.length ? '' : 'none';
  const target = unloadTarget();
  unloadBtn.title = target ? `Unload ${target} and give the cards back` : '';
  renderDetail();
}

/**
 * code -> an actionable sentence with a link to the setting that fixes it.
 * 🔴 THE SENTENCE, NOT THE CODE. An earlier tab rendered `kobold_auth` because
 * `jget` dropped the response body, and a route that carefully returns both a code to branch on
 * and a sentence to read is worth nothing if the sentence is lost in transit. Same shape here.
 * @param {any} e
 */
export function llaErrHtml(e) {
  const b = (e && e.body) || {};
  const msg = b.message || (e && e.message) || 'llama.cpp is not answering.';
  const settings = ' <a href="#" id="llaToSettings">⚙ Settings ▸ llama.cpp</a>';
  if (b.error === 'llama_unconfigured') return `${esc(msg)}${settings}`;
  if (b.error === 'llama_auth') return `${esc(msg)}${settings}`;
  return esc(msg);
}

/** Wire the ⚙ link an error card just wrote, if it wrote one. */
function wireSettingsLink() {
  const a = $('llaToSettings');
  if (!a) return;
  a.addEventListener('click', ev => {
    ev.preventDefault();
    switchTab('settings');
    const el = $('llaUrl');
    if (el) el.focus();
  });
}

/** @param {string} html */
function showUnavail(html) {
  const u = $('llaUnavail');
  const m = $('llaMain');
  if (u) u.style.display = '';
  if (m) m.style.display = 'none';
  const msg = $('llaUnavailMsg');
  if (msg) msg.innerHTML = html;
  wireSettingsLink();
}

/** The sentence shown when the llama-server address is not treated as this machine (release audit
 * 2026-10-11, item 8): in the Docker package a server on the same machine is reached as
 * `host.docker.internal`, which looks remote, and the way to say "it is here" is
 * `VOCALIS_LLAMA_LOCAL=1` in compose.local.yaml. Exported for the specs. @returns {string} */
export function llaNotLocalNote() {
  return DOCKER
    ? 'Vocalis is not treating this server as being on this machine, so VRAM is not measured here. If it is on this machine, add VOCALIS_LLAMA_LOCAL=1 for Vocalis in compose.local.yaml and restart Vocalis.'
    : 'Vocalis is not treating this server as being on this machine, so VRAM is not measured here. If it is on this machine, set VOCALIS_LLAMA_LOCAL=1.';
}

/** Paint the model list and the status line from whatever `lla` currently holds. */
function paint() {
  const info = lla.info || {};
  const st = lla.status || {};
  const u = $('llaUnavail');
  const main = $('llaMain');
  if (u) u.style.display = 'none';
  if (main) main.style.display = '';

  const host = $('llaHostLine');
  if (host) {
    const where = info.local ? 'this machine' : `<b>${esc(info.host || '')}</b>`;
    const mode = st.mode === 'router' ? 'router mode' : 'single-model mode';
    host.innerHTML =
      `llama-server on ${where} — ${esc(mode)}` +
      (info.build_info ? ` · <span class="muted">${esc(info.build_info)}</span>` : '') +
      (info.local ? '' : ` · <span class="muted">${esc(llaNotLocalNote())}</span>`);
  }

  paintPicker();

  // NOT an error card. A fixed-model server is a working server; this says what to change only
  // if he wants load/unload, and it is muted rather than red for that reason.
  const single = $('llaSingle');
  if (single) {
    if (st.mode && st.mode !== 'router') {
      single.style.display = '';
      single.innerHTML =
        'Started with a fixed model (<code>-m</code>), so there is nothing to load or unload here. ' +
        'Start <code>llama-server</code> with no model and a <code>--models-preset</code> to manage models from Vocalis.';
    } else {
      single.style.display = 'none';
    }
  }

  // 🔴 WHAT IS ON THE CARDS IS THE LAST MODEL THAT WAS LOADED, AND VOCALIS DID NOT
  // NECESSARILY LOAD IT. 9.5.20 recorded the pick from the drop-down and the Load button only, so
  // a model started any other way — a curl, a script, llama-server's own autoload — left nothing
  // remembered, and the moment it stopped holding VRAM (it slept, the router dropped it, the box
  // restarted) the panel fell back to whatever the router lists first. Remember the last model
  // loaded, not merely the last row clicked in this panel; an observed load is the best evidence.
  //
  // ⚠️ THIS IS NOT THE THING kobold.js FORBIDS. Its rule — persist where a human chose,
  // never from the paint — exists so a SERVER DEFAULT cannot masquerade as a decision. `rows[0]`
  // is such a default and is still never written. A model holding VRAM is not a default: it is a
  // load that actually happened.
  noteHeld(lla.models.filter(m => m.holds_vram).map(m => m.id));

  const status = $('llaStatus');
  if (status) {
    const holding = lla.models.filter(m => m.holds_vram).map(m => m.id);
    // 🔴 `running` INCLUDES sleeping, so it is reported SEPARATELY rather than folded in. A
    // sleeping model is routable and holds nothing; one number cannot say both.
    const running = lla.models.filter(m => m.running && !m.holds_vram).length;
    status.innerHTML = holding.length
      ? `<span style="color:var(--ok)">●</span> holding the cards: <b>${holding.map(esc).join(', ')}</b>`
      : '<span class="muted">○ no model is holding the cards.</span>';
    if (running) status.innerHTML += ` <span class="small muted">(${running} loading or sleeping)</span>`;
  }

  const vram = $('llaVram');
  if (vram) {
    if (st.vram_measurable === false) {
      // NO NUMBER, and deliberately not a 0 — this box has no sensor for another box's cards.
      vram.textContent = 'Memory use is not measurable from here — Vocalis is not treating llama-server as running on this machine.';
    } else if (st.mode === 'router') {
      const max = st.max_instances;
      const auto = st.models_autoload;
      // Read, never assumed. With autoload on, a model can appear because SillyTavern asked for
      // it, with no click here at all — which is why this line exists rather than a reassurance.
      vram.textContent =
        (max ? `Up to ${max} model${max === 1 ? '' : 's'} at once. ` : '') +
        (auto ? 'Autoload is ON: a request for an unloaded model loads it.' : 'Autoload is off.');
    } else {
      vram.textContent = '';
    }
  }
}

/**
 * The ticked-cards warning, per engine (9.3's, generalized at 9.5-m2).
 *
 * 🔴 IT NAMES THE CARDS. "Some cards are in use" is a sentence you can only act on by going
 * and looking; `cuda:0 - NVIDIA ...` is the row to untick. The route sends the LIST for exactly
 * that reason rather than a boolean it had already decided.
 *
 * 📌 EMPTY STRING WHEN THERE IS NOTHING TO SAY, so the caller concatenates it
 * unconditionally. Three ways to get one and they are the same answer: the setting is off,
 * llama-server is on another box (the route sends neither field), or nothing is ticked.
 */
function llaGpuWarnHtml() {
  const s = lla.status;
  if (!s || !s.warn_gpus) return '';
  /** @type {{id: string, label: string}[]} */
  const cards = s.vocalis_gpus || [];
  if (!cards.length) return '';
  const rows = cards.map(c => `<li><code>${esc(c.id)}</code> \u2014 ${esc(c.label)}</li>`).join('');
  return (
    `<div style="margin-top:8px"><b>Vocalis still has ${cards.length === 1 ? 'a card' : cards.length + ' cards'} ticked on this box</b>, and llama-server runs here too \u2014 so the model is about to load onto hardware Vocalis is holding:</div>` +
    `<ul style="margin:6px 0 0 18px">${rows}</ul>` +
    `<div class="small muted" style="margin-top:8px">Untick them in \u2699 Settings \u25b8 Devices to give the memory back.</div>` +
    `<div class="small muted" style="margin-top:6px">Turn this off under <b>Devices</b> in \u2699 Settings \u2014 the same box that warns you the other way round.</div>`
  );
}

/**
 * Confirm before a load or an unload.
 *
 * 🔴 CANCEL IS FIRST, AND IT HAS TO BE. `modal()` resolves `actions[0].value` on Esc AND on a
 * backdrop click. With Continue first, tapping Esc on "Unload the model?" resolves 1 and goes
 * ahead \u2014 the destructive default, reachable by the key everyone presses to back out. That is a
 * real bug 9.3 found in the Kobold twin; do not reintroduce it here by reordering.
 *
 * 🔴 THE CARDS WARNING IS PASSED IN, NEVER APPENDED HERE. It belongs to the LOAD path only
 * -- `kobLoad` passes it and `kobUnload` does not, for the reason `llaAct` states below: an
 * unload GIVES the memory back, so warning that Vocalis is holding cards is irrelevant there and,
 * read literally, backward. The first version appended `llaGpuWarnHtml()` unconditionally, so the
 * unload dialog carried it while the comment three functions down said it did not.
 * @param {string} title
 * @param {string} why
 * @param {string} [warn] - the ticked-cards block. LOAD PATH ONLY.
 */
function llaConfirm(title, why, warn) {
  return modal(title, why + (warn || ''), [
    { label: 'Cancel', value: 0 },
    { label: 'Continue', class: 'primary', value: 1 },
  ]);
}

/**
 * Load or unload one model, after asking.
 *
 * ⚠️ THE LOAD DIALOG WARNS ABOUT THE CARDS; THE UNLOAD ONE DOES NOT NEED TO \u2014 giving memory
 * back is the safe direction. What the unload dialog says instead is that anything mid-reply on
 * that model dies, which is the consequence a user actually pays.
 * @param {string} id
 * @param {boolean} unloading
 */
async function llaAct(id, unloading) {
  const go = unloading
    ? await llaConfirm(
        'Unload this model?',
        `<div><b>${esc(id)}</b> will be unloaded and its memory released.</div>` +
          `<div style="margin-top:8px">If SillyTavern (or anything else) is mid-reply on it right now, <b>that reply dies</b>.</div>`,
      )
    : await llaConfirm('Load this model?', `<div>llama-server will load <b>${esc(id)}</b>.</div>`, llaGpuWarnHtml());
  if (!go) return;
  // 🔴 A LOAD IS A CHOICE TOO, and the `change` listener above cannot see this one: a fresh
  // browser opens on the fallback row, and pressing Load on the row that was already showing
  // fires no `change` event at all. Remember the model loaded so it is selected on the next visit,
  // whether or not the user touched the drop-down to get there. An UNLOAD deliberately does not
  // clear it: the last model loaded is still the one to return to.
  if (!unloading) rememberPick(id);
  const out = $('llaStatus');
  try {
    await jpost(unloading ? '/llama/unload' : '/llama/load', { model: id });
    // 🔴 NO ETA AND NO CLAIM THAT IT IS DONE. A load answers `loading: true` \u2014 llama-server's
    // own success means STARTED \u2014 so the poll below is what turns it into an observation.
    if (out) out.innerHTML = unloading ? 'Unloading\u2026' : 'Loading\u2026 (this can take a while)';
  } catch (e) {
    if (out) out.innerHTML = `<span style="color:var(--bad)">\u2716</span> ${llaErrHtml(e)}`;
    return;
  }
  await pollOnce();
}

// The two buttons are in the PARTIAL and never rewritten, so these attach once at module-eval
// rather than being re-bound on every 4 s poll.
const loadBtnEl = $('llaLoad');
if (loadBtnEl) {
  loadBtnEl.addEventListener('click', () => {
    const sel = /** @type {HTMLSelectElement} */ ($('llaSel'));
    if (sel && sel.value) llaAct(sel.value, false);
  });
}
const unloadBtnEl = $('llaUnload');
if (unloadBtnEl) {
  unloadBtnEl.addEventListener('click', () => {
    // 🔴 THE SAME RULE THE TOOLTIP WAS PAINTED FROM, from the same function. Reading
    // `holds_vram` again here is how the two get to disagree.
    const target = unloadTarget();
    if (target) llaAct(target, true);
  });
}
// Repaint the buttons the instant the selection changes, so Load can disappear when the user picks
// the model that is already in -- waiting for the next poll would leave a live button lying.
//
// 🔴 AND THE PICK IS PERSISTED HERE, NOT IN THE PAINT. Only a human choosing a row writes it, so
// nothing the fallback chain preselected can masquerade as a user choice; writing it back
// from `paintPicker()` would freeze the first day's default in place forever. kobold.js carries
// the same sentence over `#kobSel` for the same reason.
const selEl = $('llaSel');
if (selEl)
  selEl.addEventListener('change', () => {
    rememberPick(/** @type {HTMLSelectElement} */ (selEl).value);
    paintPicker();
  });
/** One poll: status + models. Errors paint the unavailable card rather than throwing. */
async function pollOnce() {
  try {
    const [st, ms] = await Promise.all([jget('/llama/status'), jget('/llama/models')]);
    lla.status = st;
    lla.models = (ms && ms.models) || [];
    paint();
  } catch (e) {
    showUnavail(llaErrHtml(e));
  }
}

/** Entering the llama.cpp sub-tab. */
export async function llaLoadAll() {
  try {
    lla.info = await jget('/llama/info');
  } catch (e) {
    showUnavail(llaErrHtml(e));
    return;
  }
  if (!lla.info.configured) {
    showUnavail(
      'No llama.cpp URL is set. Add one in <a href="#" id="llaToSettings">⚙ Settings ▸ llama.cpp</a> ' +
        'to use this tab. Nothing else in Vocalis needs it.',
    );
    return;
  }
  if (!lla.info.available) {
    showUnavail(
      `No llama-server answered at <code>${esc(lla.info.url || '')}</code>. ` +
        `<span class="small muted">${esc(lla.info.error || '')}</span> ` +
        '<a href="#" id="llaToSettings">⚙ Settings ▸ llama.cpp</a>',
    );
    return;
  }
  await pollOnce();
  llaPollStop();
  // 🔴 THE STOP HALF IS IN js/llm/tabs.js AND IT IS NOT OPTIONAL. Without it this interval polls
  // a model server nobody is looking at, forever — the invariant every enter/leave pair in
  // js/ui/tabs.js carries a warning about.
  lla.timer = setInterval(pollOnce, 4000);
}

/** Leaving the llama.cpp sub-tab. Idempotent — llmPollStop calls it for both engines. */
export function llaPollStop() {
  if (lla.timer) {
    clearInterval(lla.timer);
    lla.timer = null;
  }
}

/**
 * Paint ⚙ Settings ▸ llama.cpp from `/settings/app`.
 * 🔴 THE KEY FIELD NEVER ROUND-TRIPS. The GET returns `llama_api_key_set` as a BOOL, so the input
 * stays EMPTY except while typing — which is also what makes "Show key" safe to offer at all.
 * @param {any} s
 */
export function llaRenderSettings(s) {
  const url = /** @type {HTMLInputElement} */ ($('llaUrl'));
  if (url) url.value = s.llama_url || '';
  // 🔴 NO `#llaWarnGpus` (9.5.9). One checkbox governs the ticked-cards warning in both
  // directions — `#devWarnLlm` in ⚙ Settings ▸ Devices — and this panel used to paint and save a
  // second one over the same fact. `/llama/status` reads `devices_warn_llm_loaded` for its
  // `warn_gpus` now; see kobold.js's note for the whole argument.
  const state = $('llaPwState');
  if (state) {
    state.textContent = s.llama_api_key_set
      ? 'An API key is stored.'
      : 'No API key stored — fine unless llama-server was started with --api-key.';
  }
  const wrap = $('llaShowWrap');
  // Where the CSS mask is unsupported the checkbox would be a LIE — unchecked beside a visible
  // secret. Feature-detect and hide it: degrade, do not mislead. (4.7's rule, unchanged.)
  if (wrap && !(window.CSS && CSS.supports && CSS.supports('-webkit-text-security', 'disc'))) {
    wrap.style.display = 'none';
  }
}

const showBox = /** @type {HTMLInputElement} */ ($('llaShow'));
if (showBox) {
  // 🔴 FLIPS THE CLASS, NEVER `el.type`. `el.type = 'text'` is the obvious one-liner, looks
  // identical on screen, and re-arms spell-jacking AND hands the field back to Chrome's password
  // manager — undoing both of 4.7's decisions invisibly.
  showBox.addEventListener('change', () => {
    const el = $('llaToken');
    if (el) el.classList.toggle('masked', !showBox.checked);
  });
}

/** @param {boolean} clear - true clears the stored key; false saves whatever is typed. */
async function saveSettings(clear) {
  const url = /** @type {HTMLInputElement} */ ($('llaUrl'));
  const tok = /** @type {HTMLInputElement} */ ($('llaToken'));
  /** @type {any} */
  const body = { llama_url: url ? url.value.trim() : '' };
  // OMITTED means untouched, "" means clear. Only send the key when there is something to say
  // about it, or every URL edit would wipe a stored credential.
  if (clear) body.llama_api_key = '';
  else if (tok && tok.value) body.llama_api_key = tok.value;
  const out = $('llaTestResult');
  try {
    await jput('/settings/app', body);
    if (tok) tok.value = '';
    const s = await jget('/settings/app');
    llaRenderSettings(s);
    // Saving TESTS it. Being told nothing after saving a URL is a guess, and the failure it
    // guesses wrong about is invisible until the tab is opened.
    const v = await jpost('/llama/test', {});
    if (out) {
      out.style.display = '';
      out.innerHTML = v.ok
        ? `<span style="color:var(--ok)">✔</span> ${esc(v.message || `llama-server answered — ${v.models} model${v.models === 1 ? '' : 's'}.`)}`
        : `<span style="color:var(--bad)">✖</span> ${esc(v.message || 'llama.cpp did not answer.')}`;
    }
  } catch (e) {
    if (out) {
      out.style.display = '';
      out.innerHTML = `<span style="color:var(--bad)">✖</span> ${llaErrHtml(e)}`;
    }
  }
}

const saveBtn = $('llaSave');
if (saveBtn) saveBtn.addEventListener('click', () => saveSettings(false));
const clearBtn = $('llaClear');
if (clearBtn) clearBtn.addEventListener('click', () => saveSettings(true));
