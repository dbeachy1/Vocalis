// Shared log rendering and controls. `logInto` appends markup to a pane and optionally follows
// its tail. Book and Bulk have independent auto-scroll toggles; the other logs follow on their
// own rules. Every log that follows its tail also uses `followWhenShown`, so it is on its last
// line when its tab comes back.
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

/**
 * Put a following log pane back on its last line when it comes back on screen.
 *
 * A pane on a hidden tab (`display:none`) cannot scroll: setting `scrollTop` does nothing, and
 * the browser keeps the old position. So lines that arrived while you were on another tab left
 * the pane showing old text, with auto-scroll still on, until the next line arrived (Doug,
 * 2026-10-23, on Book ▸ Generate). Showing the pane again resizes it from nothing, which is what
 * the observer catches; a width change that rewraps lines is caught the same way. A font-size
 * change re-wraps the text of a log that scales with it without resizing the pane, so
 * `uiFontApply` announces it instead.
 *
 * @param {VEl} pane
 * @param {() => boolean} [follows] whether the pane follows its tail right now. Omitted, it
 *   follows when it was at the tail the last time it scrolled on screen: the rule of logs with
 *   no auto-scroll control, which follow until you scroll up to read back. Their appends scroll
 *   to the tail, which counts as being there.
 */
export function followWhenShown(pane, follows) {
  let atTail = true;
  pane.addEventListener('scroll', () => {
    if (pane.clientHeight) atTail = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  });
  const snap = () => {
    if (pane.clientHeight && (follows ? follows() : atTail)) pane.scrollTop = pane.scrollHeight;
  };
  new ResizeObserver(snap).observe(pane);
  window.addEventListener('vocalis:fontsize', snap);
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
    // Hidden, the pane measures zero and its position means nothing; it must not change the box.
    if (pane.clientHeight && pane.scrollTop + pane.clientHeight < pane.scrollHeight - 30) checkbox.checked = false;
  });
  followWhenShown(pane, () => checkbox.checked);
}

bindAutoScroll('autoscroll', 'log');
bindAutoScroll('blkAutoscroll', 'blkLog');
