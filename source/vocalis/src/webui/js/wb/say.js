// The editor's message line, and the closed list of things a message may offer to do.
// 7.1 §5.5 — module 5, and the half of the `wbSay` ↔ `st.js` cycle that goes first.
//
// 🔴 THIS MODULE EXISTS SO THAT `st.js` CAN MOVE AT ALL, AND THE ORDER IS FORCED BOTH WAYS.
// `st.js` calls `wbSay`, so `wbSay` has to be a module before it (the bridge publishes
// module → inline, never the reverse). But `WB_ACTIONS` NAMED `wbStSweepCancel` and
// `wbStSendCancel`, which live in `st.js` — so `wbSay` also depended on `st.js`. That is a genuine
// cycle, and §5.5 says do NOT resolve it by moving both at once into mutually-importing modules:
// ES modules permit that and hoisting would probably make it work, which is exactly what makes it
// dangerous — it keeps working until someone converts one of those functions to a `const` arrow,
// at which point it becomes a temporal-dead-zone error at load, silently, on a button nobody
// clicks in testing.
//
// ✅ BROKEN BY REGISTRATION INSTEAD, so the edge disappears rather than being tolerated. The map
// is now a registry: `st.js` calls `registerWbAction('wbStSweepCancel', fn)` at module load, and
// nothing in this file names the cancels. It also matches what the map was already FOR — a closed
// list of names a message line may call.
//
// ⚠️ THE DELEGATED LISTENER MOVED WITH THEM, and it had to: it is the registry's only reader, the
// same reason the backdrop listener had to move with `modal` (§5.4). A top-level statement in a
// module is safe — it registers after parsing and still catches every later click.
//
// 📌 The old comment warned that this listener was deliberately OUTSIDE every range the smoke
// specs slice, because a top-level statement executed in their stub sandbox has no `document`.
// That still holds and is still worth checking: `grab()` compiles only a function's own source
// (its regex stops at the closing brace), so a listener sitting between two functions in this file
// is never run by it. Do not add a `grab()` for something in here without re-reading that.

import { esc, wbEl } from '../util/dom.js';

/** The Cancel button a message line may offer — `{fn}` names an entry in `WB_ACTIONS`. */
/** @typedef {{fn: string, label: string}} WbSayAction */

// 🔴 `fn` NAMES AN ENTRY IN THE REGISTRY. IT IS NOT A GLOBAL (7.1 §5.2).
// It used to be interpolated straight into an `onclick="…"` attribute, which resolves the name off
// `window` at click time. Module scope makes that lookup find nothing — and the failure is SILENT:
// the button renders, it clicks, and nothing happens, with no error anywhere anyone is looking.
//
// ⚠️ A new action is still declared in BOTH places — registered here, named at the call site. That
// is the feature, not the friction: this is the closed list of names a message line may call,
// which is what keeps "never anything from the server" true by construction rather than by
// comment. Registration widened WHO may add a name; it did not open the list to arbitrary ones.
// ⚠️ THE SECOND PARAMETER IS OPTIONAL AND THE DELEGATED LISTENER NEVER PASSES IT (9.7.1). A
// message-line button still calls `run(kind)` and nothing else; `wbStSweep` takes a completion
// callback for `runWbAction` callers only. A one-parameter function stays assignable to this, so
// the two cancels are unchanged.
/** @type {Record<string, (kind: string, done?: (r: any) => void) => unknown>} */
const WB_ACTIONS = {};

/**
 * Publish an action a message line may offer, by the name `wbSay(..., {fn})` will use.
 *
 * 🔴 CALLED AT MODULE LOAD BY THE MODULE THAT OWNS THE FUNCTION — that is the point. It inverts
 * the dependency so this file never has to name, or import, anything from `st.js`.
 *
 * @param {string} name
 * @param {(kind: string) => unknown} fn
 */
export function registerWbAction(name, fn) {
  WB_ACTIONS[name] = fn;
}

/** Invoke a registered editor action without importing its owning module. Unknown names return undefined; callers that need execution status must check registration separately.
 * @param {string} name
 * @param {string} kind
 * @param {(r: any) => void} [done]
 * @returns {unknown}
 */
export function runWbAction(name, kind, done) {
  const fn = WB_ACTIONS[name];
  return fn ? fn(kind, done) : undefined;
}

// One delegated listener for every message line, in the same style as `kobSettingsLink`.
// Registered once rather than per render, so `wbSay` never has to clean up after itself:
// `el.innerHTML = …` throws the old buttons away and this listener is still here for the new ones.
document.addEventListener('click', e => {
  const b =
    e.target && /** @type {Element} */ (e.target).closest && /** @type {Element} */ (e.target).closest('[data-wbact],[data-wbhush]');
  if (!b) return;
  if (b.hasAttribute('data-wbhush')) {
    wbHush(/** @type {string} */ (b.getAttribute('data-wbhush')));
    return;
  }
  const run = WB_ACTIONS[/** @type {string} */ (b.getAttribute('data-wbact'))];
  if (run) run(/** @type {string} */ (b.getAttribute('data-wbkind')));
});

/**
 * @param {string} kind
 * @param {string} text
 * @param {boolean|string} [tone] - `true` is shorthand for `'bad'`; otherwise one of
 *   `'bad'|'ok'|'busy'|''`.
 * @param {WbSayAction} [action]
 */
export function wbSay(kind, text, tone, action) {
  const el = /** @type {VEl} */ (wbEl(kind, 'wbMsg'));
  if (!el) return;
  const t = tone === true ? 'bad' : tone || '';
  clearTimeout(el._t);
  // The spinner trails the text because that is where he asked for it, and because a leading
  // spinner shifts the message sideways the instant it clears.
  const html =
    esc(text) +
    (t === 'busy' ? '<span class="spin after"></span>' : '') +
    (action
      ? '<button type="button" class="sm" style="margin-left:8px"' +
        ' data-wbact="' +
        esc(action.fn) +
        '" data-wbkind="' +
        esc(kind) +
        '">' +
        esc(action.label) +
        '</button>'
      : '') +
    (t === 'ok' || t === 'bad'
      ? '<button type="button" class="wbx" title="dismiss" aria-label="dismiss"' + ' data-wbhush="' + esc(kind) + '">✕</button>'
      : '');
  const cls = 'small ' + (t === 'bad' ? 'wbbad' : t === 'ok' ? 'wbok' : t === 'busy' ? 'wbbusy' : 'muted');
  el.innerHTML = html;
  el.className = cls;
  wbMirror(kind, html, cls);
  if (!t) el._t = setTimeout(() => wbHush(kind), 6000);
}

/** Render status in the message strip nearest the action. Write to the stable library strip and display only the strip appropriate to the current editor placement; hidden elements retain their content for tests and controls.
 * @param {string} kind
 * @param {string} html
 * @param {string} cls
 */
function wbMirror(kind, html, cls) {
  const lib = /** @type {VEl} */ (wbEl(kind, 'wbMsg'));
  const panel = /** @type {VEl} */ (wbEl(kind, 'wbEditor'));
  // The editor is open when its panel is on the page and not display:none — the same test
  // `wbPlaceEditor` and `wbClose` maintain, read rather than tracked, so a close path that
  // forgets to tell this function cannot leave a stale copy behind.
  const open = !!(panel && panel.style.display !== 'none');
  const ed = wbMsgEd(kind);
  if (ed) {
    ed.innerHTML = open ? html : '';
    ed.className = open ? cls : 'small muted';
  }
  if (lib) lib.style.display = open ? 'none' : '';
}

/** Create the editor-local status strip on first use, adjacent to the editor toolbar. Keeping creation beside the writer avoids duplicating per-pane markup.
 * @param {string} kind
 * @returns {VEl|null}
 */
function wbMsgEd(kind) {
  const existing = /** @type {VEl} */ (wbEl(kind, 'wbMsgEd'));
  if (existing) return existing;
  const panel = /** @type {VEl} */ (wbEl(kind, 'wbEditor'));
  if (!panel) return null;
  // `.logwrap` is the editor's header row in all three panes. Falling back to the panel's first
  // child rather than bailing keeps a future pane that spells its header differently from silently
  // losing its message line — the failure would be invisible, which is the one this whole change
  // is about.
  const header = panel.querySelector(':scope > .logwrap') || panel.firstElementChild;
  const el = document.createElement('div');
  el.id = 'wbMsgEd_' + kind;
  el.className = 'small muted';
  el.style.minHeight = '1.2em';
  el.style.margin = '6px 0 8px';
  if (header && header.nextSibling) panel.insertBefore(el, header.nextSibling);
  else panel.appendChild(el);
  return /** @type {VEl} */ (el);
}

/** @param {string} kind */
export function wbHush(kind) {
  const el = /** @type {VEl} */ (wbEl(kind, 'wbMsg'));
  if (!el) return;
  clearTimeout(el._t);
  el.textContent = '';
  el.className = 'small muted';
  // 🔴 THE COPY IS CLEARED TOO, AND THE LIBRARY STRIP COMES BACK. A ✕ that emptied one of the two
  // would leave the other holding a message he had just dismissed — and since the ✕ carries
  // `data-wbhush` and the listener is delegated on `document`, the press can arrive from EITHER
  // copy. One clear, both strips, whichever one he clicked.
  const ed = /** @type {VEl} */ (wbEl(kind, 'wbMsgEd'));
  if (ed) {
    ed.textContent = '';
    ed.className = 'small muted';
  }
  el.style.display = '';
}
