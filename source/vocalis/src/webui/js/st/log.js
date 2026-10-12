// st/log.js — the SillyTavern tab's live log tail (7.3-m4k).
//
// Moved verbatim from index.html's `── the live log tail ──` banner: 51 lines, seven definitions
// and four wirings. It polls `/logs/tail` with a byte cursor, so the server returns only what is
// new and each poll is cheap.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — two names, both called by the tab machinery.
//
//   stLogStart   `switchStTab`'s `case 'logs': stLogStart(); break;`
//   stLogStop    the same switch, and `switchTab`'s
//                `if(name!=='sillytavern'){stLogStop();stPollStop();}`
//
// 🔴 THE PAIR IS THE POINT, AND SO IS THE `if(!stLogTimer)` GUARD IN `stLogStart`. Entering the
// Logs sub-tab twice without leaving the tab in between would otherwise leave two intervals
// polling the same route forever, and the second one is invisible: the log simply fills at double
// speed and the box thrashes. `stLogStop` clearing the handle is the other half.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 FOUR PIECES OF STATE STAY MODULE-PRIVATE AND COULD NOT BE PUBLISHED ANYWAY. `stLogTimer`,
// `stLogCursor`, `stLogPaused` and `stLogBusy` are `let`s this file reassigns on nearly every
// poll, and §11.4's rule is that `Object.assign(window, mod)` copies a VALUE once at module load.
// Nothing outside reads them, which is what makes the module correct rather than merely legal.
//
// 📌 `stLogBusy` IS A REENTRANCY LATCH, NOT A CACHE. A poll that runs slower than the 1200 ms tick
// would otherwise stack requests against a server that is already struggling, which is precisely
// when the log is worth reading.
//
// ⚠️ THREE BEHAVIORS IN HERE READ AS INCIDENTAL AND ARE NOT:
//   - The bottom is followed only when you are ALREADY at the bottom, measured BEFORE the append.
//     Scrolling up to read back must not be yanked away a tick later.
//   - `ST_LOG_CAP` bounds the DOM, because this is a tail somebody leaves open for hours.
//   - `textContent`, never `innerHTML`: these lines are server output, and the filter re-applies
//     to lines already on screen by toggling a class rather than re-rendering them.
//
// ⚠️ It reaches for NO inline global. `$` and `jget` are imports.

import { $ } from '../util/dom.js';
import { jget } from '../util/http.js';
// ── the live log tail ────────────────────────────────────────────────────
// Poll /logs/tail with a byte cursor: the server returns only what's new since
// the cursor, so each poll is cheap. We follow the bottom unless the user has
// scrolled up to read back, and cap the on-screen buffer so a long watch can't
// grow the DOM without bound. Lines are colored by their loguru level token.
const ST_LOG_CAP = 2000;
let stLogTimer = 0,
  stLogCursor = -1,
  stLogPaused = false,
  stLogBusy = false;
export function stLogStart() {
  if (!stLogTimer) {
    stLogPoll();
    stLogTimer = setInterval(stLogPoll, 1200);
  }
}
export function stLogStop() {
  if (stLogTimer) {
    clearInterval(stLogTimer);
    stLogTimer = 0;
  }
}
async function stLogPoll() {
  if (stLogPaused || stLogBusy) return; // never stack polls if one runs slow
  stLogBusy = true;
  try {
    const r = await jget('/logs/tail?cursor=' + stLogCursor);
    if (r.missing) {
      if (!(/** @type {VEl} */ ($('stLogView')).childElementCount))
        /** @type {VEl} */ ($('stLogView')).innerHTML =
          '<div class="stLogLine muted">No log file yet — it appears once the server writes its first line.</div>';
      return;
    }
    if (r.rotated) /** @type {VEl} */ ($('stLogView')).innerHTML = ''; // the file rolled over — start clean
    stLogCursor = r.cursor;
    if (r.text) stLogAppend(r.text);
  } catch (e) {
    /* transient (a redeploy, a network blip) — the next tick retries */
  } finally {
    stLogBusy = false;
  }
}
/** @param {string} line */
function stLogLevelClass(line) {
  if (/\|\s*(ERROR|CRITICAL)\s*\|/.test(line)) return 'drop';
  if (/\|\s*WARNING\s*\|/.test(line)) return 'warn';
  if (/\|\s*SUCCESS\s*\|/.test(line)) return 'ok';
  return '';
}
/** @param {string} text */
function stLogAppend(text) {
  const box = /** @type {VEl} */ ($('stLogView')),
    q = /** @type {HTMLInputElement} */ ($('stLogFilter')).value.trim().toLowerCase();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40; // check BEFORE we append
  const frag = document.createDocumentFragment();
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const d = document.createElement('div');
    d.className = 'stLogLine ' + stLogLevelClass(raw);
    if (q && !raw.toLowerCase().includes(q)) d.classList.add('hide');
    d.textContent = raw;
    frag.appendChild(d);
  }
  box.appendChild(frag);
  while (box.childElementCount > ST_LOG_CAP) box.removeChild(/** @type {ChildNode} */ (box.firstChild));
  if (atBottom) box.scrollTop = box.scrollHeight; // follow the tail unless reading back
}
/** @type {VEl} */ ($('stLogFilter')).addEventListener('input', () => {
  // re-apply the filter to lines already shown
  const q = /** @type {HTMLInputElement} */ ($('stLogFilter')).value.trim().toLowerCase();
  /** @type {VEl} */ ($('stLogView'))
    .querySelectorAll('.stLogLine')
    .forEach(d => d.classList.toggle('hide', !!q && !d.textContent.toLowerCase().includes(q)));
});
/** @type {VEl} */ ($('stLogPause')).onclick = () => {
  stLogPaused = !stLogPaused;
  /** @type {VEl} */ ($('stLogPause')).classList.toggle('on', stLogPaused);
  /** @type {VEl} */ ($('stLogPause')).textContent = stLogPaused ? '▶ Resume' : '⏸ Pause';
};
/** @type {VEl} */ ($('stLogClear')).onclick = () => {
  /** @type {VEl} */ ($('stLogView')).innerHTML = '';
}; // view only; the file is untouched
