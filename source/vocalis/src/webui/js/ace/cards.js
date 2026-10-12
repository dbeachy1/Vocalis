// ace/cards.js — the per-card config rows at the top of the ACE-Step tab (8.0-m2, §4.5.1).
//
// One row per authorized card:
//
//     cuda:0   [ acestep-v15-xl-sft ▾ ]   ● xl-sft loaded
//     cuda:1   [ acestep-v15-turbo  ▾ ]   ◐ loading turbo…
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE DROPDOWN IS THE ARCHITECTURE, NOT A CONVENIENCE.
//
// An ACE-Step backend is pinned to one card by HIP_VISIBLE_DEVICES at unit start, and its
// `--device` argument takes no index — so a card's model is a property OF THAT CARD, not
// something a render request can choose. That is why the control lives here, above the form,
// instead of being a field on it: Generate sends one job to each card and each card renders
// with whatever it is holding.
//
// ⚠️ Do not pin models to card positions or add a scheduler: users may need identical models for
// two drafts or different models for a draft/final pair. The selector leaves that choice explicit.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THREE STATES, NOT TWO, AND THE THIRD ONE IS WHY THIS FILE EXISTS.
//
// "Service up" and "model loaded" are different facts, and a backend can be answering HTTP
// while holding nothing — generate then fails with "Model not fully initialized", and the control
// that fixes it may be buried in a Gradio accordion unrelated to the card.
//
// And loading is a THIRD state: xl-sft is 19 GB, so "not loaded" and "40 seconds into arriving"
// look identical over /health and feel identical to someone staring at a dropdown that appears
// to have done nothing. `/acestep/status` carries `loading` separately for exactly that.

import { $, esc } from '../util/dom.js';
import { jget, jpost } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { onAceStatus } from '../sys/acestep.js';
import { DOCKER } from '../sys/modelstate.js'; // the Docker-package flag, from /health
// UIS, not localStorage: the vault-backed account store. See tray.js's note — a `vocalis-*`
// key written straight to localStorage is swept off the client on the next boot.
import { UIS } from '../util/uistate.js';

// ── 🔴 TYPES FOR THE TWO POLLED SHAPES THIS FILE READS (8.3-m2) ────────────────────────────────
// Named off the fields actually READ below, not off the Flask routes' full response — same
// discipline as `types/vocalis.d.ts`'s header for `AppState`.
/**
 * @typedef {object} AceModelInfo
 * @property {string[]} [models]
 * @property {string} [default]
 */
/**
 * `/acestep/models`, per device.
 * @typedef {object} AceInventory
 * @property {Record<string, AceModelInfo>} [backends]
 */
// 🔴 `AceStatus` AND ITS BACKEND ROW ARE AMBIENT, FROM `types/vocalis.d.ts`. They used to be
// declared here AND in `sys/acestep.js`, which publishes the poll this file subscribes to via
// `onAceStatus` — two statements about one payload, and they disagreed about `loading` within a
// single pass. This file had it right (it RENDERS the value: `loading ${esc(b.loading)}…`, the
// model name from `runtime/acestep.py:674`); the other said `boolean`. One declaration now, in
// the file whose job is the project's real types.
//
// ⚠️ The local name was `AceBackendStatus`; the shared one is `AceBackend`. Same shape.
/**
 * One card's `/acestep/lora/<device>` answer, as read by loraCell/loraCall below.
 * @typedef {object} AceLoraStatus
 * @property {boolean} [loaded]
 * @property {number} [scale]
 * @property {boolean} [use_lora]
 * @property {string} [active_adapter]
 * @property {string} [adapter_type]
 */

/** @type {AceInventory|null} */
let INV = null; // /acestep/models — see refreshInventoryIfBackendsCameUp below
/** @type {AceStatus|null} */
let LAST = null; // the most recent /acestep/status, so a dropdown change can repaint now

// 🔴 THE INVENTORY IS NOT A ONE-SHOT, AND ASSUMING IT WAS SHIPPED AN EMPTY DROPDOWN.
// It was fetched once at boot on the reasoning that "the model list only changes on disk" —
// true of the DISK, false of what a backend will TELL you. A stopped backend answers the
// inventory with an empty list, so a page loaded while the service was down baked
// `models: []` in permanently: the 4 s status poll would go on to report the backend up and
// the row would say "no model loaded", while the dropdown beside it stayed dead with a single
// "—". Refresh the inventory when a backend transitions from down to up.
// So: remember which devices were up last time, and re-fetch when any of them flips down->up.
// That is once per service start, not once per poll — the disk reasoning still holds for the
// steady state, it just was not the whole story.
let UP_LAST = '';

// 🔴 WHAT THE USER PICKED, PER CARD — AND WHY IT HAS TO LIVE OUT HERE.
// The rows are re-rendered wholesale on every status tick, i.e. every 4 seconds, and rowHtml
// rebuilds the <select> from `b.model || inv.default`. With nothing loaded that is always the
// backend's default, so a selection was silently reverted within one poll of making it.
// Without this state, a render on the four-second poll reset a new selection to the backend
// default whenever no model was loaded.
// ⚠️ This is the cost of repainting from state on a timer: anything the USER put in the DOM is
// not in that state and gets erased. The selection is now state too.
const CHOSEN = Object.create(null);

// 🔴 AND IT OUTLIVES THE PAGE, because the card's model is a decision, not a scratch value.
// Persist the selected model per card so it survives page reloads and stopped backends. A stopped
// backend reports no model at all, and falling through to the
// inventory's default is what made every stopped card claim turbo.
/** @param {string} dev */
const MK = dev => 'vocalis-ace-model-' + dev;
/** @param {string} dev */
const remembered = dev => UIS.getItem(MK(dev)) || '';
/**
 * @param {string} dev
 * @param {string} model
 */
function rememberModel(dev, model) {
  if (!dev || !model) return;
  CHOSEN[dev] = model;
  UIS.setItem(MK(dev), model);
}

// 🔴 ONE POLL, TWO CONSUMERS. sys/acestep.js already polls /acestep/status every 4 s for the
// header button; this subscribes to the same result rather than opening a second timer against
// the same route. Two pollers would double the request rate and drift out of step, so the rows
// and the button could disagree about whether a backend is up.
/**
 * @param {string} device
 * @returns {AceBackend|null}
 */
function statusFor(device) {
  return ((LAST && LAST.backends) || []).find(b => b.device === device) || null;
}

/** @param {AceBackend|null} b */
function stateCell(b) {
  if (!b) return '<span class="muted">—</span>';
  // 🔴 BEFORE the `up` check. An unticked card's backend may be perfectly alive — the service
  // lifecycle is not gated by the tick (8.0-m5) — and "service down" would be a lie about a
  // running process. What is actually true is that this card may not hold a model.
  if (b.authorized === false) {
    return '<span class="muted">○ not ticked for “ACE-Step” under ⚙ Settings ▸ Devices</span>';
  }
  // 🔴 NOT ANSWERING IS NOT THE SAME AS NOT RUNNING (8.9.9). `up` is `/health` replying inside
  // three seconds, and a backend that is importing torch or pulling 19 GB of weights replies to
  // nothing — so `up:false` on its own cannot tell a stopped service from a starting one. The
  // systemd unit state can, and it is the only thing that can; an active unit with no health
  // response is starting, not stopped.
  // ⚠️ `unit == null` means systemd could not be asked, which is a THIRD state and falls through
  // to the honest "down" wording only because `up` is also false — we know nothing better.
  if (!b.up && b.unit === 'active') return `<span class="spin"></span> starting…`;
  if (!b.up) return '<span class="muted">○ service down</span>';
  if (b.loading) return `<span class="spin"></span> loading ${esc(b.loading)}…`;
  if (b.model_loaded === null) return '<span class="muted">? model state unknown</span>';
  if (!b.model_loaded) return '<span class="muted">○ no model loaded</span>';
  return `<span class="ok">●</span> ${esc(b.model || 'a model')} loaded`;
}

// ── 🔴 8.1-m6: LoRA LIVES ON THE CARD, AND THE DESIGN PUT IT IN ADVANCED ───────────────────
//
// §9 lists `use_lora`, `lora_path` and `lora_scale` as three Advanced fields. Measured: `lora`
// appears nowhere on ACE-Step's request model, nowhere in its alias table and nowhere in
// `job_generation_setup`. There is no per-render field. It is backend state behind five routes,
// so it belongs exactly where the model dropdown is — and for the identical reason `ace/form.js`
// gives for there being no model control on the song form: a backend is pinned to its card, so a
// per-SONG adapter control would be a second, contradictory answer to a question the card owns.
//
// ⚠️ THE SAME ENABLE RULE AS UNLOAD, and for the same reason rather than for symmetry. Every LoRA
// route calls `_require_initialized_handler` upstream, so a card holding no model answers an
// error — the control has to be dead exactly when the model state says it would be.
//
// 📌 UNLOADING AN ADAPTER IS NOT UNLOADING THE MODEL. It drops the adapter and leaves the 14-19 GB
// base resident, which is a very different cost from the button two cells to the left. The words
// have to keep those apart or someone frees a card meaning to change an adapter.
//
// ⚠️ Keep this as a path input: `/v1/lora/load` reads from the backend filesystem, and Vocalis
// has no adapter store or browse endpoint.
/** @type {Map<string, AceLoraStatus>} */
const LORA = new Map(); // device -> the last /acestep/lora/<device> answer

// 🔴 WHAT THE USER HAS TYPED INTO THE PATH BOX, PER CARD — the CHOSEN lesson again, one control
// later. The rows are rebuilt wholesale on every 4 s status tick and rowHtml rendered this input
// with no value, so a path being typed was erased mid-keystroke: Attach was usable only by
// pasting and clicking inside one poll interval. Anything the USER puts in the DOM must be state,
// or the timer eats it. Kept after a Detach too, deliberately — re-attaching should not cost
// re-typing the path a mis-click just lost.
const TYPED = Object.create(null); // device -> the .aceloradpath draft

document.addEventListener('input', ev => {
  const el = /** @type {Element} */ (ev.target);
  if (!el || !el.classList || !el.classList.contains('aceloradpath')) return;
  const row = /** @type {HTMLElement|null} */ (el.closest && el.closest('.acecard'));
  if (row && row.dataset.device) TYPED[row.dataset.device] = /** @type {HTMLInputElement} */ (el).value;
});

// 🔴 IT SAYS "LoRA" IN WORDS, AND IT IS ONLY THERE ONCE A MODEL IS LOADED. The only thing naming
// the control was the input's PLACEHOLDER, which the
// box was too narrow to finish — the visible text ended at "LoRA path on the ACE-Step |" — so what
// was left on screen was an unexplained Attach sitting one cell from Load, reading as a second,
// contradictory step in loading the model it has nothing to do with.
//
// So the row now carries a literal `LoRA` label, and the whole cell is ABSENT on a card holding no
// model instead of present-and-disabled. That is not a retreat from this tab's "disabled with a
// reason, not hidden" rule — it is §3's own split, the one `ace/form.js` applies to the Source row:
// a field a mode ADDS has nothing to show when it does not apply, while an INERT one still tells
// you what the value would have been. An empty path box on a dead card is the former. It has no
// value to preserve, and the fix it wants to advertise — load a model — is the row it sits under.
// Release audit 2026-10-11, item 9. The backend opens the adapter path itself, inside the process
// it runs in. In the Docker package that is the container, which sees the install's models folder
// (`<install folder>/models/vocalis`, mounted at /models/vocalis, the same mount the ACE-Step model
// files are read from) and nothing else on the host, so "a path on the server" sent people to host
// paths that cannot be opened. Exported for the specs.
/** @returns {string} */
export function loraPathPlaceholder() {
  return DOCKER ? '/models/vocalis/lora/<adapter>' : 'path to an adapter on the ACE-Step box';
}
/** @returns {string} */
export function loraPathTitle() {
  return DOCKER
    ? 'The adapter has to be inside the models folder of your Vocalis install (the models/vocalis folder), because ACE-Step can only open what is mounted into the container. Put it in a sub-folder there, for example models/vocalis/lora, and type its path as seen from inside: /models/vocalis/lora/<adapter>.'
    : 'A path on the server — the backend opens it directly.';
}

/**
 * @param {string} device
 * @param {boolean} loaded
 */
function loraCell(device, loaded) {
  // No model on this card: every LoRA route upstream calls `_require_initialized_handler` and 400s,
  // so there is nothing here to offer and nothing to keep. Attaching becomes possible the moment
  // Load finishes, and the 4 s status tick repaints this row then.
  if (!loaded) return '';
  const st = LORA.get(device) || {};
  const has = !!st.loaded;
  const scale = st.scale === undefined || st.scale === null ? 1 : st.scale;
  const lbl =
    '<span class="acelorlbl" title="A LoRA adapter — an optional fine-tune laid on TOP of' +
    ' the model this card already holds. Nothing to do with loading the model itself, and leaving' +
    ' this empty is the ordinary case.">LoRA</span>';
  if (!has) {
    return `<span class="acelora">${lbl}
      <input type="text" class="aceloradpath" placeholder="${esc(loraPathPlaceholder())}"
             value="${esc(TYPED[device] || '')}"
             title="${esc(loraPathTitle())}">
      <button class="btn xs aceloraload"
        title="${esc('Attach this adapter to the model on this card. The model itself is already loaded — this only adds the fine-tune on top of it.')}">Attach</button>
    </span>`;
  }
  return `<span class="acelora">${lbl}
    <label class="chk" title="${esc('Use the attached adapter, or ignore it WITHOUT detaching — an A/B with no reload.')}">
      <input type="checkbox" class="aceloratoggle"${st.use_lora ? ' checked' : ''}>
      ${esc(st.active_adapter || st.adapter_type || 'attached')}</label>
    <input type="number" class="acelorascale" min="0" max="2" step="0.05" value="${esc(String(scale))}"
           title="How strongly the adapter applies. 1 is as trained.">
    <button class="btn xs aceloradrop"
      title="${esc('Detach the adapter and go back to the base model. This does NOT free the card — the base model stays resident.')}">Detach</button>
  </span>`;
}

/**
 * @param {string} device
 * @param {AceModelInfo|null|undefined} inv
 */
function rowHtml(device, inv) {
  const b = statusFor(device);
  const models = (inv && inv.models) || [];
  // The selected value is what the backend HOLDS, falling back to what it would load. On a
  // backend that is down there is nothing to say, so the select is disabled rather than
  // offering a choice that cannot be acted on.
  // A pending choice outranks what the backend holds: it is the thing the user is about to press
  // Load for. Only honored while the model still exists in the inventory, so a stale pick cannot
  // survive a model disappearing from disk.
  // The remembered choice seeds CHOSEN on first paint, so a reload starts where you left off.
  if (!(device in CHOSEN)) {
    const r = remembered(device);
    if (r) CHOSEN[device] = r;
  }
  const pending = CHOSEN[device] && models.includes(CHOSEN[device]) ? CHOSEN[device] : null;
  // ⚠️ ORDER MATTERS. A live `loading` beats everything — it is happening now. Then the
  // explicit choice, then what the backend actually holds, then the remembered one for a
  // backend that is DOWN and therefore reports nothing. The inventory default is last, and is
  // now only reached on a card that has never been chosen for at all.
  const current = (b && b.loading) || pending || (b && b.model) || remembered(device) || (inv && inv.default) || '';
  const busy = !!(b && b.loading);
  // An unticked card is offered nothing to choose: /acestep/init would refuse it, and a live
  // dropdown that always errors is worse than a disabled one that says why in the state cell.
  const dead = !b || !b.up || !models.length || b.authorized === false;
  const opts = models.map(m => `<option value="${esc(m)}"${m === current ? ' selected' : ''}>${esc(m)}</option>`).join('');
  // 🔴 AN EXPLICIT BUTTON, BECAUSE `change` DOES NOT FIRE ON THE VALUE ALREADY SHOWING.

  // The load used to be a side effect of the <select>'s change event. The select pre-selects
  // what the backend WOULD load (`inv.default`) when nothing is loaded yet — so the very first
  // thing a user does, picking the model already displayed, is not a change, fires no event, and
  // does nothing at all. The dropdown was
  // never the place for it: a control that acts on selection cannot be re-pressed, cannot show
  // that it is the thing to press, and has nowhere to put its opposite.
  const loaded = !!(b && b.model_loaded);
  const same = loaded && b.model === current;
  // 🔴 UNLOAD IS OFFERED ONLY WHEN THERE IS SOMETHING TO FREE, and the answer was always right
  // here: `model_loaded` comes off each backend's /health, and it is the same field printing
  // "○ no model loaded" in the cell beside this button. The unload action is unavailable on an
  // empty card.
  // `busy` counts as holding: a submitted render or model operation owns the card until it settles
  // or the local child is confirmed exited.
  const holds = !!b && (busy || (b.up === true && b.model_loaded === true));
  const unloadWhy =
    !b || b.up !== true
      ? 'The backend child on this card is not running — nothing to unload.'
      : busy
        ? 'Stop the owned child to end submitted work and release this card after exit is confirmed.'
        : b.model_loaded === true
          ? 'Stop this card’s local child to unload its model. The other card is untouched.'
          : 'No model is loaded on this card, so there is no memory to hand back.';
  return `<div class="acecard" data-device="${esc(device)}">
    <span class="acedev">${esc(device)}</span>
    <select class="acemodel"${dead || busy ? ' disabled' : ''}>${opts || '<option>—</option>'}</select>
    <button class="btn aceload"${dead || busy || same ? ' disabled' : ''}
      title="${
        same ? 'This model is already loaded on this card' : 'Read this model onto the card — minutes for xl-sft'
      }">${loaded ? 'Swap' : 'Load'}</button>
    <button class="btn aceunload"${holds ? '' : ' disabled'}
      title="${esc(unloadWhy)}">Unload (stop child)</button>
    <span class="acestate">${stateCell(b)}</span>
    ${loraCell(device, loaded)}
  </div>`;
}

export function paintAceCards() {
  const host = $('aceCards');
  if (!host) return;
  const devices = ((LAST && LAST.backends) || []).map(b => b.device);
  if (!LAST || !LAST.available) {
    // ⚠️ NOT an error, and not empty. A box with no ACE-Step is the ordinary case, and a blank
    // panel would read as "broken" rather than "not installed here".
    // ⚠️ This is now "not INSTALLED", not "not ticked" — the tick no longer decides whether the
    // panel exists (8.0-m5), so pointing the reader at Devices here would send them to a setting
    // that cannot fix it.
    host.innerHTML = '<div class="small muted">No ACE-Step backend is installed on this box.</div>';
    return;
  }
  // ⚠️ FOCUS SURVIVES THE REPAINT. `TYPED` keeps the path's VALUE, but replacing the node the
  // user is typing into still threw their caret away every 4 s — value preserved, focus stolen
  // is still an unusable control. Capture which lora input holds focus (they are the only
  // free-typing controls in these rows), rebuild, then put the caret back where it was.
  const act = /** @type {HTMLInputElement|null} */ (document.activeElement);
  let keep = null;
  if (act && host.contains(act) && act.classList && (act.classList.contains('aceloradpath') || act.classList.contains('acelorascale'))) {
    const row = /** @type {HTMLElement|null} */ (act.closest('.acecard'));
    if (row && row.dataset.device) {
      keep = {
        device: row.dataset.device,
        cls: act.classList.contains('aceloradpath') ? 'aceloradpath' : 'acelorascale',
        value: act.value,
        s: act.selectionStart,
        e: act.selectionEnd,
      };
    }
  }
  host.innerHTML = devices.map(d => rowHtml(d, INV && INV.backends && INV.backends[d])).join('');
  if (keep) {
    const el = /** @type {HTMLInputElement|null} */ (host.querySelector(`.acecard[data-device="${CSS.escape(keep.device)}"] .${keep.cls}`));
    if (el && !el.disabled) {
      el.value = keep.value;
      el.focus();
      // number inputs refuse setSelectionRange; the caret lands at the end there, which is fine
      try {
        el.setSelectionRange(keep.s, keep.e);
      } catch (e) {
        /* see above */
      }
    }
  }
}

async function loadInventory() {
  try {
    INV = await jget('/acestep/models');
  } catch (e) {
    INV = null;
  }
  paintAceCards();
}

// Re-fetch the inventory when any backend transitions down->up. See the note on UP_LAST: a
// backend that was down when the page loaded reported no models, and without this the dropdown
// never recovers. Keyed on the set of UP devices, so a steady state costs nothing and a service
// start costs exactly one extra request.
/** @param {AceStatus|null|undefined} status */
function refreshInventoryIfBackendsCameUp(status) {
  const up = ((status && status.backends) || [])
    .filter(b => b.up)
    .map(b => b.device)
    .sort();
  const key = up.join(',');
  if (key === UP_LAST) return;
  const gained = up.some(d => !UP_LAST.split(',').filter(Boolean).includes(d));
  UP_LAST = key;
  if (gained) loadInventory();
}

// Remember the choice, and do nothing else. The dropdown is a selection, not an action — see the
// note in rowHtml. Without this the pick is erased by the next 4 s repaint.
document.addEventListener('change', ev => {
  const sel = /** @type {Element} */ (ev.target);
  if (!sel || !sel.classList || !sel.classList.contains('acemodel')) return;
  const row = /** @type {HTMLElement|null} */ (sel.closest('.acecard'));
  if (!row) return;
  rememberModel(/** @type {string} */ (row.dataset.device), /** @type {HTMLSelectElement} */ (sel).value);
  paintAceCards(); // so Load/Swap re-evaluates against the new choice immediately
});

// Delegated off the document, because the rows are re-rendered on every status tick — a handler
// bound to a button would be discarded four seconds later.
// ⚠️ Selecting in the dropdown no longer DOES anything on its own; it only chooses what Load
// will read. See the note in rowHtml: acting on `change` meant the first thing anyone tries —
// pressing the model already displayed — fired no event and looked broken.
document.addEventListener('click', async ev => {
  const btn = /** @type {HTMLButtonElement|null} */ (
    ev.target &&
      /** @type {Element} */ (ev.target).closest &&
      /** @type {Element} */ (ev.target).closest('.aceload,.aceunload,.aceloraload,.aceloradrop')
  );
  if (!btn || btn.disabled) return;
  const row = /** @type {HTMLElement|null} */ (btn.closest('.acecard'));
  if (!row) return;
  const device = /** @type {string} */ (row.dataset.device);
  const b = statusFor(device);

  // 8.1-m6. Detach asks first: the adapter path is typed by hand and losing it to a mis-click
  // means typing it again, which is exactly the sort of small hostility this panel avoids.
  // (TYPED above also remembers the path across the detach, so even an accepted Detach does not
  // cost the typing — the confirm is for the state change, the store is for the words.)
  if (btn.classList.contains('aceloraload') || btn.classList.contains('aceloradrop')) {
    const drop = btn.classList.contains('aceloradrop');
    const body = drop
      ? { action: 'unload' }
      : { action: 'load', lora_path: /** @type {{value?: string}} */ (row.querySelector('.aceloradpath') || {}).value || '' };
    if (!drop && !String(body.lora_path).trim()) {
      await modal('No adapter path', 'Type the path to the adapter first.', [{ label: 'OK', class: 'primary', value: 1 }]);
      return;
    }
    if (drop) {
      const ok = await modal(
        'Detach the adapter on ' + esc(device) + '?',
        'The base model stays resident — this only removes the adapter. The path box keeps ' +
          'what you typed, so re-attaching is one click.',
        [
          { label: 'Cancel', value: 0 },
          { label: 'Detach', class: 'danger', value: 1 },
        ],
      );
      if (!ok) return;
    }
    await loraCall(device, body);
    return;
  }

  if (btn.classList.contains('aceunload')) {
    // Unload stops only this card's owned child; submitted work ends when that child exits.
    const ok = await modal(
      'Unload the model on ' + esc(device) + '?',
      `This stops the local ACE-Step child on <b>${esc(device)}</b>. Any submitted render on ` +
        `that card ends when child exit is confirmed; its model must be initialized again before ` +
        `more work can run. Finished candidates may be unavailable after the child stops. Other ` +
        `cards are unaffected.`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Unload and stop', class: 'danger', value: 1 },
      ],
    );
    if (!ok) return;
    try {
      await jpost('/acestep/unload', { device });
    } catch (e) {
      await modal('Could not stop that backend', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
    }
    paintAceCards();
    return;
  }

  const sel = /** @type {HTMLSelectElement|null} */ (row.querySelector('.acemodel'));
  const model = sel && sel.value;
  if (!model || model === '—') return;

  // Swapping a loaded model replaces what the child currently holds. Active work disables this
  // control and the server also rejects initialization while a render owns the card.
  if (b && b.model_loaded) {
    const ok = await modal(
      'Swap the model on ' + esc(device) + '?',
      `${esc(device)} is holding <b>${esc(b.model || 'a model')}</b>. Loading ` +
        `<b>${esc(model)}</b> replaces it. A render already using this card must finish first; ` +
        `the selected model must be initialized again before the card can accept more work.`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Load ' + model, class: 'danger', value: 1 },
      ],
    );
    if (!ok) {
      paintAceCards();
      return;
    }
  }

  try {
    await jpost('/acestep/init', { device, model });
    rememberModel(device, model); // a load is the strongest form of choosing
  } catch (e) {
    await modal('Cannot load that model', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    paintAceCards();
    return;
  }
  // Reflect it immediately rather than waiting up to 4 s for the next status tick — the load
  // takes minutes and a row that looks inert for four seconds is a row people click twice.
  if (LAST) {
    LAST = {
      ...LAST,
      backends: (LAST.backends || []).map(x => (x.device === device ? { ...x, loading: model } : x)),
    };
  }
  paintAceCards();
});

// 🔴 ONE CALLER FOR ALL FOUR VERBS, and it repaints from the STATUS the route hands back rather
// than from what was asked for. A toggle that painted itself optimistically would be a checkbox
// asserting an adapter is active when the backend refused — the same class of lie as the ST
// button that said "nothing cached" over a cached song.
/**
 * @param {string} device
 * @param {Record<string, unknown>} body
 */
async function loraCall(device, body) {
  try {
    const r = await jpost('/acestep/lora/' + encodeURIComponent(device), body);
    if (r && r.status) LORA.set(device, r.status);
  } catch (e) {
    // The backend's own sentence: "Model not fully initialized" names the fix, and a generic
    // message would hide it.
    await modal('LoRA on ' + esc(device), esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  }
  paintAceCards();
}

document.addEventListener('change', async ev => {
  const el = /** @type {Element} */ (ev.target);
  if (!el || !el.classList || /** @type {HTMLInputElement} */ (el).disabled) return;
  const row = /** @type {HTMLElement|null} */ (el.closest && el.closest('.acecard'));
  if (!row) return;
  if (el.classList.contains('aceloratoggle')) {
    await loraCall(/** @type {string} */ (row.dataset.device), {
      action: 'toggle',
      use_lora: /** @type {HTMLInputElement} */ (el).checked,
    });
  } else if (el.classList.contains('acelorascale')) {
    // ⚠️ BLANK IS NOT ZERO. `Number('') || 0` sent a cleared box as an explicit scale-0 — mute —
    // while the server's old `or 1.0` read a 0 as full strength: both ends eating the value in
    // opposite directions. Now: blank omits the field (the server defaults it to 1.0), an
    // explicit 0 travels as 0 and mutes, junk goes nowhere.
    const v = /** @type {HTMLInputElement} */ (el).value === '' ? null : Number(/** @type {HTMLInputElement} */ (el).value);
    if (v !== null && !Number.isFinite(v)) return;
    await loraCall(/** @type {string} */ (row.dataset.device), v === null ? { action: 'scale' } : { action: 'scale', scale: v });
  }
});

//: Asked once per card whenever the model state CHANGES, never on the 4 s status tick — an
//: adapter cannot attach itself, so polling it would be a round trip per card per tick to learn
//: nothing. The one thing that can change it from outside is a model load, which is what this
//: keys on.
let LORA_SEEN = '';

/** @param {AceStatus|null|undefined} s */
function refreshLoraIfModelsChanged(s) {
  const key = ((s && s.backends) || []).map(b => `${b.device}:${b.model_loaded === true ? b.model || '1' : '0'}`).join('|');
  if (key === LORA_SEEN) return;
  LORA_SEEN = key;
  for (const b of (s && s.backends) || []) {
    if (b.model_loaded !== true) {
      LORA.delete(b.device);
      continue;
    }
    jget('/acestep/lora/' + encodeURIComponent(b.device))
      .then(st => {
        LORA.set(b.device, st);
        paintAceCards();
      })
      .catch(() => {
        /* the card renders without it; the next model change asks again */
      });
  }
}

// `onAceStatus`'s own `fn` parameter is unannotated (sys/acestep.js, Writer F's file), so nothing
// flows a type into this callback from the call site — `s` is typed here, inline, the same way
// `paintAceCards` casts `document.activeElement` above.
onAceStatus((/** @type {AceStatus} */ s) => {
  const first = LAST === null;
  LAST = s;
  if (first && s && s.available)
    loadInventory(); // the model list, when there is first a box
  else paintAceCards();
  // 🔴 AFTER the first-load branch, and unconditional. The old code fetched the inventory once
  // and never again, which was fine only if every backend was already up at page load. This
  // catches the case that shipped broken: open the tab, start the service, and the dropdown
  // fills itself instead of staying empty until a reload.
  refreshInventoryIfBackendsCameUp(s);
  refreshLoraIfModelsChanged(s);
  // 🔴 THE ADVANCED PANEL NEEDS TO KNOW WHAT THE CARDS HOLD, because three of its knobs have no
  // single default — Steps, Timestep shift and DCW are decided by each card's model. Showing
  // "default 1 · turbo 3" beside a box running xl-sft reads as though the default were the string
  // "1 · turbo 3".
  // This is that fact, forwarded off the poll that already carries it — no second timer, and no
  // second idea of what is loaded.
  // 🔴 AND THE CAPABILITY MAP RIDES THE SAME EVENT (8.1). `ace/form.js` gates its mode buttons on
  // each card's `supported_task_types` — Gradio guesses from the model's PATH NAME and gets it
  // wrong on the checkpoint in production, so the backend's own answer is the only authority.
  // (SUPERSEDED October 11, 2026: the backend's answer is only an is_turbo flag, and acestep-v15-xl-sft
  // and acestep-v15-xl-base share one config.json, so the engine claims Extract/Replace/Complete for
  // both. The SERVER now narrows each model's list to what its publisher lists — acegen.PUBLISHED_TASKS —
  // and this event carries that narrowed list plus `task_models`, so the rule below still holds: the
  // page believes the server's per-model answer and never sniffs a name.)
  // ⚠️ IT WAS EXPORTED AND NEVER CALLED, which meant CARD_TASKS stayed empty and every mode was
  // offered on every card whatever it could run. `task_type` is a bare `str` upstream, so an
  // unsupported one is not refused at the door — it fails deeper, or quietly. Same never-wired
  // shape as the mode selector that never painted; caught the same way, by looking for the call.
  document.dispatchEvent(
    new CustomEvent('ace:cardmodels', {
      detail: {
        models: ((s && s.backends) || []).filter(b => b.model_loaded === true && b.model).map(b => b.model),
        byDevice: (INV && INV.backends) || {},
      },
    }),
  );
});
