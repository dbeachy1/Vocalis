/** Render live and saved-per-revision model logs. Keep `st.logLive` as the guard between the two painters; each updates the shared element around its fetch.
 */
import { $, esc, wbEl } from '../util/dom.js'; // 7.3-m13: `$` was reached off the shim
import { jget } from '../util/http.js';
import { wbState } from './state.js';

// ── §6.4.3 the model log ─────────────────────────────────────────────────
//
// 🔴 THIS DELIBERATELY DOES NOT RIDE THE SSE STREAM. I16 forbids field text on
// `/pass/<id>/events`, and every row here IS field text. It is an ordinary authenticated fetch,
// the same footing as `/revision/<n>` and `/proposal/<index>`, which already return document text.
// 🔴 ONE SECOND WHILE A PASS RUNS. The old 3s was
// not the reason the window was empty — nothing was RECORDED until a reply landed, which the
// server side now fixes — but a diagnostic should not lag behind itself.
const WB_LOG_POLL_MS = 1000;

/**
 * One row from `/wbedit/pass/<id>/<passId>/log` or the saved per-revision
 * `/wbedit/documents/<id>/log/<n>` — two shapes share one array. `event === 'pass.start'` marks a
 * run boundary and carries `model`/`instruction`; anything else is one request/reply exchange,
 * with `reply` staying `null` while the model has not answered yet.
 * @typedef {Object} WbLogRow
 * @property {string} [event]
 * @property {string} [model]
 * @property {string} [instruction]
 * @property {number} [n]
 * @property {{messages?: {role?: string, content?: unknown}[]}} [request] - everything but
 *   `messages` is sampler params, rendered verbatim via `Object.entries`.
 * @property {unknown} [reply]
 */

/** @param {string} kind */
export function wbLogStart(kind) {
  const st = wbState(kind);
  /** @type {VEl} */ (wbEl(kind, 'wbLog')).style.display = '';
  wbLogFold(kind);
  /** @type {VEl} */ (wbEl(kind, 'wbLogBody')).innerHTML = '<span class="muted">sending the first request…</span>';
  wbLogHead(kind, 'live', true);
  st.logLive = true;
  if (st.logTimer) clearInterval(st.logTimer);
  st.logTimer = setInterval(() => wbLoadLog(kind).catch(() => {}), WB_LOG_POLL_MS);
  wbLoadLog(kind).catch(() => {});
}

// Fold/unfold the body. The header row — title, live count, spinner and this very button —
// is never touched, which is the whole point (see the click handler for why).
/** @param {string} kind */
export function wbLogFold(kind) {
  const st = wbState(kind);
  const wrap = /** @type {VEl} */ (wbEl(kind, 'wbLogWrap'));
  const btn = /** @type {VEl} */ (wbEl(kind, 'wbLogCollapse'));
  if (wrap) wrap.style.display = st.logFolded ? 'none' : '';
  if (btn) btn.textContent = st.logFolded ? '▸ Expand' : '▾ Collapse';
}

/** @param {string} kind */
export function wbLogStop(kind) {
  const st = wbState(kind);
  if (st.logTimer) {
    clearInterval(st.logTimer);
    st.logTimer = null;
  }
}

// The header line includes a spinner while a request is active.
/**
 * @param {string} kind
 * @param {string} text
 * @param {boolean} busy
 */
function wbLogHead(kind, text, busy) {
  /** @type {VEl} */ (wbEl(kind, 'wbLogCount')).innerHTML = esc(text) + (busy ? '<span class="spin after"></span>' : '');
}

// 🔴 FOLLOW THE TAIL, BUT NEVER YANK HIM BACK DOWN. Same rule as `stLogAppend`: measure BEFORE
// the write, restore after. `wbRenderLog` replaces innerHTML wholesale, which is what used to
// throw the scroll position away on every poll.
/**
 * @param {VEl} el
 * @param {WbLogRow[]} rows
 */
function wbLogPaint(el, rows) {
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  wbRenderLog(el, rows);
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// 🔴 TWO FETCHES, ONE PANE, AND WHOEVER LANDS LAST WINS UNLESS SOMEBODY GUARDS IT.
// `wbLoadLog` and `wbLoadSavedLog` paint the SAME element from different sources. Open a
// revision (saved) and then press Run pass (live) and the saved fetch, still in flight, resolves
// afterward and repaints the pane over the live one — with "No pass has been run against this
// revision", which reads exactly like the pass is doing nothing. The reverse happens too. So
// each painter records which view it is, and drops its result if the view changed while it was
// waiting. `st.logLive` is that flag, and checking it AFTER the await is the whole point.
/** @param {string} kind */
export async function wbLoadLog(kind) {
  const st = wbState(kind);
  if (!st.doc || !st.pass) return;
  st.logLive = true;
  const body = await jget(`/wbedit/pass/${encodeURIComponent(st.doc.id)}/${encodeURIComponent(st.pass.id)}/log`);
  if (!st.logLive) return; // a saved revision took the pane while we were away
  if (!body.running) wbLogStop(kind);
  const el = /** @type {VEl} */ (wbEl(kind, 'wbLogBody'));
  if (!body.available) {
    el.innerHTML =
      '<span class="muted">This pass is no longer in memory, so its log is gone. ' + 'The revisions it produced are unaffected.</span>';
    wbLogHead(kind, '', false);
    return;
  }
  /** @type {WbLogRow[]} */
  const xs = body.exchanges;
  // An open row (`reply === null`) means a request is in flight — that is the spinner's subject
  // and it is why the count says "1 in flight" rather than a bare number.
  const waiting = xs.length && xs[xs.length - 1].reply == null;
  const parts = [];
  if (xs.length) parts.push(`${xs.length} exchange${xs.length === 1 ? '' : 's'}`);
  if (body.dropped) parts.push(`${body.dropped} older dropped`);
  if (waiting) parts.push('waiting for the model');
  wbLogHead(kind, 'live' + (parts.length ? ' · ' + parts.join(' · ') : ''), !!body.running);
// 🔴 "no exchange yet" IS GONE. This state is only reachable between starting a pass and
  // the first request being built, and it no longer claims nothing was sent.
  if (!xs.length) {
    el.innerHTML = '<span class="muted">sending the first request…</span>';
    return;
  }
  wbLogPaint(el, xs);
}

// The SAVED log for one version (§6.4.3). A version's log holds every run made while that version
// was live — including rejected runs, which can explain
// that explains why the next version looks the way it does.
/**
 * @param {string} kind
 * @param {number} n - the revision this log belongs to.
 */
export async function wbLoadSavedLog(kind, n) {
  const st = wbState(kind);
  if (!st.doc) return;
  st.logLive = false;
  const el = /** @type {VEl} */ (wbEl(kind, 'wbLogBody'));
  const body = await jget(`/wbedit/documents/${encodeURIComponent(st.doc.id)}/log/${n}`);
  if (st.logLive) return; // a pass started while we were away — it owns the pane
  /** @type {WbLogRow[]} */
  const rows = body.rows || [];
  const runs = rows.filter(r => r.event === 'pass.start').length;
  const xs = rows.filter(r => r.event !== 'pass.start');
  // 🔴 SAY THAT IT IS THE SAVED ONE (§9a.13a). After a restart the live view is gone but this
  // file survives, so a label such as "3 runs, 6 exchanges" could be mistaken for the active pass.
  // A header that says `live` for one and `saved` for the other makes the distinction clear.
  wbLogHead(
    kind,
    xs.length
      ? `saved · revision ${n} · ${runs} run${runs === 1 ? '' : 's'} · ${xs.length} exchange${xs.length === 1 ? '' : 's'}`
      : `saved · revision ${n}`,
    false,
  );
  if (!rows.length) {
    el.innerHTML =
      '<span class="muted">No pass has been run against this revision. ' + 'Hand edits do not use the model, so they leave no log.</span>';
    return;
  }
  wbLogPaint(el, rows);
}

// 🔴 `esc()` ON EVERY PIECE. This renders raw model output and raw card text into the DOM, and a
// card is allowed to contain angle brackets — `<START>` is literally IN the baseline prompt.
/**
 * @param {VEl} el
 * @param {WbLogRow[]} rows
 */
function wbRenderLog(el, rows) {
  el.innerHTML = rows
    .map(x => {
      if (x.event === 'pass.start') {
        return `<div class="wblogx"><div class="wblogh"><b>▶ run started</b>
        <span class="small muted">${esc(x.model || '')}</span></div>
        <pre class="small">${esc(x.instruction || '')}</pre></div>`;
      }
      const msgs = (x.request && x.request.messages) || [];
      const sampler = Object.fromEntries(Object.entries(x.request || {}).filter(([k]) => k !== 'messages'));
      return `<div class="wblogx">
      <div class="wblogh"><b>#${x.n}</b>
        <span class="small muted">sent ${msgs.length} message${msgs.length === 1 ? '' : 's'}</span></div>
      <pre class="small muted">${esc(JSON.stringify(sampler))}</pre>
      ${msgs
        .map(
          m => `<div class="wblogrole small">▸ ${esc(m.role || '')}</div>
        <pre>${esc(m.content == null ? '' : String(m.content))}</pre>`,
        )
        .join('')}
      <div class="wblogrole small">◂ reply</div>
      ${
        x.reply == null
          ? '<pre class="muted"><span class="spin"></span>sent — waiting for the model…</pre>'
          : `<pre>${esc(String(x.reply))}</pre>`
      }
    </div>`;
    })
    .join('');
}
