// Shared log rendering and controls. `logInto` appends markup to a pane and optionally follows
// its tail. Book and Bulk have independent auto-scroll toggles; the other four sinks keep their
// existing behavior.
//
// Only the explicit `.ph` placeholder is removed; muted log entries are ordinary content.
//
// `html` is intentionally inserted as markup. Callers must escape server text and filenames first.

/**
 * @param {VEl} box — the log pane. `VEl` rather than `Element` because every caller reaches it
 *   through `$`.
 * @param {string} html — markup, not text (see the escaping note above).
 * @param {string} [cls] - defaults to `'l'`.
 * @param {boolean} [scroll] - follow the tail when true.
 */
export function logInto(box, html, cls, scroll) {
  const f = box.querySelector('.ph');
  if (f) f.remove();
  const d = document.createElement('div');
  d.className = cls || 'l';
  d.innerHTML = html;
  box.appendChild(d);
  if (scroll) box.scrollTop = box.scrollHeight;
}

// Scrolling away disables follow mode. Checking the control again immediately follows the tail;
// the 30px slack absorbs scrollHeight rounding near the bottom.
import { $ } from '../util/dom.js';
/** @type {VEl} */ ($('copyLog')).onclick = () => navigator.clipboard.writeText(/** @type {VEl} */ ($('log')).innerText);

/** @param {string} checkboxId
 * @param {string} paneId */
function bindAutoScroll(checkboxId, paneId) {
  const checkbox = /** @type {HTMLInputElement} */ ($(checkboxId));
  const pane = /** @type {VEl} */ ($(paneId));
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) pane.scrollTop = pane.scrollHeight;
  });
  pane.addEventListener('scroll', () => {
    if (pane.scrollTop + pane.clientHeight < pane.scrollHeight - 30) checkbox.checked = false;
  });
}

bindAutoScroll('autoscroll', 'log');
bindAutoScroll('blkAutoscroll', 'blkLog');
