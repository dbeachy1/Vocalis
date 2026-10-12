// The pass: the SSE stream, the proposals it announces, and the review queue. 7.1 §5.5 — module 4.
//
// 📌 WHY THIS ONE IS NEXT. §5.5 counted the top-level functions each planned module calls but does
// not contain: this group was 6 against `open.js`'s 38, and every one of the six has now left the
// inline script or been given a module copy — `esc`/`wbEl` (dom.js), `jget`/`jpost` (http.js),
// `wbState`/`wbGen`/`wbStale` (state.js), `wbDocKind` (kind.js). The bridge only publishes
// module → inline, so a module can only leave once everything it calls has already left. That is
// what makes the count the order.
//
// ⚠️ NONE OF THESE IS REACHABLE AT PARSE TIME, hand-checked per §5.6 rather than grepped. The
// entry points are `wbRun` (a click handler), `wbLoadLib` (a click handler and the bootstrap IIFE
// *after* its first `await`), `wbRestoreReview`, `wbApply`, and three listeners `wbWire` registers.
// Registering `() => wbReview(…)` is not calling it — that distinction is the whole ordering rule,
// and a naive call-graph walk gets it wrong in exactly this direction.
//
// 🔴 NO `wbSay` HERE, WHICH IS WHY THIS MODULE HAS NO CYCLE. `st.js` does — its cancels are named
// by `wbSay`'s action map, and `wbSay` is what it calls — and that is resolved by registration
// when it moves (§5.5). Nothing in this file names `wbSay`, deliberately: see `wbFetchProposal`.

import { esc, wbEl } from '../util/dom.js';
import { jget, jpost } from '../util/http.js';
import { wbState, wbGen, wbStale } from './state.js';
import { wbDocKind } from './kind.js';

/** @param {string} kind */
export function wbStream(kind) {
  const st = wbState(kind);
  if (st.es) st.es.close();
  const url = `/wbedit/pass/${encodeURIComponent(st.doc.id)}/${encodeURIComponent(st.pass.id)}/events`;
  const es = new EventSource(url);
  st.es = es;
  es.onmessage = ev => {
    let e;
    try {
      e = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    if (e.kind === 'field.start') /** @type {VEl} */ (wbEl(kind, 'wbProgress')).textContent = `field ${e.index} of ${e.total} — ${e.label}`;
    if (e.kind === 'field.result') {
      /** @type {VEl} */ (wbEl(kind, 'wbProgress')).textContent =
        `field ${e.index} of ${e.total} — ${e.label}: ${e.status}` + (e.elapsed ? ` (${e.elapsed.toFixed(1)}s)` : '');
      // 🔴 THE FRAME HAS NO BODY IN IT. Fetch the one row it just announced.
      if (e.status !== 'NOCHANGE') wbFetchProposal(kind, e.index);
    }
    if (e.kind === 'pass.finish') {
      const t = e.tally || {};
      /** @type {VEl} */ (wbEl(kind, 'wbProgress')).textContent =
        `done — ${t.CHANGED || 0} changed, ${t.NOCHANGE || 0} unchanged, ${t.FAILED || 0} failed` +
        (t.held ? `, ${t.held} held for review` : '');
      wbFinish(kind);
    }
    if (e.kind === 'error') {
      /** @type {VEl} */ (wbEl(kind, 'wbProgress')).innerHTML = '<span class="warn">the pass failed: ' + esc(e.reason || '') + '</span>';
      wbFinish(kind);
    }
    if (e.kind === 'canceled') {
      /** @type {VEl} */ (wbEl(kind, 'wbProgress')).textContent = 'stopped — everything proposed so far is still here';
      wbFinish(kind);
    }
  };
  es.onerror = () => {
    /* the stream ends with the pass; a closed socket is not an error to report */
  };
}

// 📌 MODULE-PRIVATE, and that is a gain the move pays for. `wbStream` is its only caller anywhere
// in the file, so it does not go on `window` and the pass's end-of-run bookkeeping stops being
// something any other pane can reach into.
/** @param {string} kind */
function wbFinish(kind) {
  const st = wbState(kind);
  if (st.es) {
    st.es.close();
    st.es = null;
  }
  /** @type {HTMLButtonElement} */ (wbEl(kind, 'wbRun')).disabled = false;
  /** @type {HTMLButtonElement} */ (wbEl(kind, 'wbPreview')).disabled = false;
  /** @type {VEl} */ (wbEl(kind, 'wbCancel')).style.display = 'none';
  wbLoadInstructions(kind);
}

// 🔴 5.2's second half — THE ROW IS MARKED SEEN ONLY ONCE IT HAS ACTUALLY ARRIVED. `st.seen.add`
// used to run BEFORE the await, so any failure of that fetch retired the row permanently: the
// stream never re-sends an index, and nothing else calls this. Combined with the stream outliving
// a document switch (every one of those fetches 404s, because the URL is built from the NEW
// `st.doc.id`), the whole review queue could vanish with no error anywhere.
//
// `seen` is therefore "we have it", not "we asked for it", and the generation token makes the
// distinction meaningful: a frame that arrives for a document we have left is dropped without
// poisoning the set for the document we are on.
//
// 📌 Module-private for the same reason as `wbFinish`: `wbStream` is its only caller.
/**
 * @param {string} kind
 * @param {number} index - the field's index into `st.fields`, matching the SSE frame's `e.index`.
 */
async function wbFetchProposal(kind, index) {
  const st = wbState(kind);
  if (!st.doc || !st.pass) return;
  if (st.seen.has(index)) return;
  const seq = wbGen(kind);
  let p;
  try {
    p = await jget(`/wbedit/pass/${encodeURIComponent(st.doc.id)}/${encodeURIComponent(st.pass.id)}/proposal/${index}`);
  } catch (e) {
    // Not `wbSay` — a pass emits one of these per field and a transient failure on one row must
    // not paint over the running status line. It stays retryable instead.
    return;
  }
  if (wbStale(kind, seq)) return;
  st.seen.add(index);
  wbAddProposal(kind, p);
}

// A word-level diff, good enough to see a rename and honest about a rewrite. Not a merge: the
// server sends the whole field (I4) and this only COLORS it.
//
// ⚠️ EXPORTED SINCE 9.6, AND `wbedit_ui_smoke.mjs` STILL EXERCISES IT EITHER WAY. That spec
// pulls the function's SOURCE out with a regex and runs it in a `vm` context, so it needs the text
// rather than the binding — and it already strips a leading `export` before compiling, because a
// classic script cannot carry one. It was private while nothing else wanted it; the merge dialog
// now colors his own edits with the same function, and a second word-diff in this tree would be
// two answers to "what changed", drifting apart at the first fix to either.
/**
 * @param {string} a
 * @param {string} b
 * @returns {{before: string, after: string}}
 */
export function wbDiff(a, b) {
  const A = a.split(/(\s+)/),
    B = b.split(/(\s+)/);
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const pre = esc(A.slice(0, s).join(''));
  const post = esc(A.slice(A.length - e).join(''));
  return {
    before: pre + '<del>' + esc(A.slice(s, A.length - e).join('')) + '</del>' + post,
    after: pre + '<ins>' + esc(B.slice(s, B.length - e).join('')) + '</ins>' + post,
  };
}

/**
 * One row of `/wbedit/pass/<id>/<passId>/proposal/<index>`.
 * @typedef {Object} WbProposal
 * @property {number} index - the field's index into `st.fields`.
 * @property {string} label
 * @property {string} status
 * @property {string[]} [flags]
 * @property {string} [reason]
 * @property {string} original - the field's text before this proposal.
 * @property {string|null} [revised] - the model's proposed text, or absent/null for NOCHANGE.
 * @property {string} review - `'pending'`/`'approved'`/`'rejected'`/`'edited'`.
 */

/**
 * @param {string} kind
 * @param {WbProposal} p
 */
export function wbAddProposal(kind, p) {
  const x = /^X-/i.test(p.label);
  const div = document.createElement('div');
  div.className = 'wbprop' + (x ? ' wbx' : '');
  // ⚠️ `.dataset` VALUES ARE STRINGS. The DOM coerces a number through it at runtime today —
  // `String(...)` here just makes that coercion explicit rather than relying on it.
  div.dataset.index = String(p.index);
  // §6.3's live diff re-runs on every keystroke and needs the ORIGINAL each time, so the row keeps
  // it. ⚠️ A property, not `dataset` — an entry is user-authored content, and an attribute would write a
  // second copy of it into the markup where every DOM dump and every innerHTML read carries it.
  div._wbOriginal = p.original;
  // ⚠️ X entries are edited and queued like any other (I9). Their panes start COLLAPSED as a
  // courtesy — the user can leave details collapsed — and that is a UI default, not a
  // boundary. Approving without expanding is allowed and normal.
  div.innerHTML = `<div class="wbprophead">
      <b>${esc(p.label)}</b>
      <span class="small muted">${esc(p.status)}${p.flags && p.flags.length ? ' · ⚠ ' + esc(p.flags.join(', ')) : ''}${p.reason ? ' · ' + esc(p.reason) : ''}</span>
      <div style="flex:1"></div>
      <span class="wbverdict small"></span>
      <button class="sm wbtoggle">${x ? 'Show' : 'Hide'}</button>
      <button class="sm wbok" title="Mark this row to be applied">✓</button>
      <button class="sm wbno" title="Keep the original">✕</button>
    </div>
    <div class="wbpanes"${x ? ' style="display:none"' : ''}>
      <div class="wbpane"><div class="small muted">before</div><div class="wbbody wbbefore"></div></div>
      <div class="wbpane"><div class="small muted">after — editable</div>
        <div class="wbafter"><div class="wbbody wbhl" aria-hidden="true"></div><textarea class="wbedited" rows="8">${esc(p.revised == null ? p.original : p.revised)}</textarea></div></div>
    </div>`;
  /** @type {VEl} */ (wbEl(kind, 'wbProposals')).appendChild(div);
  // 🔴 THE FIRST PAINT GOES THROUGH THE SAME FUNCTION AS EVERY LATER ONE. Rendering the two panes
  // from a `d` computed here and then repainting them from `wbRepaintDiff` on input is two code
  // paths for one picture, and they drift: the arrival paint kept using `p.revised` long after the
  // textarea had become the source of truth.
  wbRepaintDiff(div);
  wbMarkVerdict(div, p.review);
  const n = /** @type {VEl} */ (wbEl(kind, 'wbProposals')).childElementCount;
  /** @type {VEl} */ (wbEl(kind, 'wbReviewCount')).textContent = n + ' proposal' + (n === 1 ? '' : 's');
}

/**
 * @param {Element} div - a `.wbprop` row.
 * @param {string} review
 */
export function wbMarkVerdict(div, review) {
  /** @type {HTMLElement} */ (div).dataset.review = review;
  const el = div.querySelector('.wbverdict');
  /** @type {Element} */ (el).textContent =
    review === 'approved'
      ? '✓ will apply'
      : review === 'rejected'
        ? '✕ held back'
        : review === 'edited'
          ? '✎ your words'
          : review === 'pending'
            ? '⚠ needs a look'
            : '';
  /** @type {Element} */ (el).className = 'wbverdict small ' + (review === 'rejected' ? 'muted' : review === 'pending' ? 'warn' : '');
}

// 🔴 THE BASELINE IS `p.original`, NEVER THE MODEL'S PROPOSAL. The left pane is what the document
// says today, and typing on the right has to move the red on the left — which it cannot do if the
// comparison restarts from whatever the model happened to return. That is also why the row carries
// `_wbOriginal` rather than reading `ta.defaultValue`, which holds the proposal.
//
// ⚠️ ONE BLOCK PER KEYSTROKE, NEVER THE DOCUMENT (§6.3). This walks a single field.
/** @param {Element} div - a `.wbprop` row. */
export function wbRepaintDiff(div) {
  const ta = div.querySelector('.wbedited');
  if (!ta) return;
  const original = div._wbOriginal == null ? '' : div._wbOriginal;
  const d = wbDiff(original, /** @type {HTMLTextAreaElement} */ (ta).value);
  /** @type {Element} */ (div.querySelector('.wbbefore')).innerHTML = d.before;
  // ⚠️ The trailing zero-width space is load-bearing. `white-space:pre-wrap` renders no line box for
  // a trailing newline, so a field ending with Enter leaves the highlight layer one line shorter
  // than the textarea it is painting behind — and every highlight below the fold sits one line high.
  /** @type {Element} */ (div.querySelector('.wbhl')).innerHTML = d.after + '​';
  // "A row with changes is marked in the list itself … so the changed ones are findable by scrolling
  // rather than by reading" (§6.3). It tracks the CURRENT text, so a hand-edit that puts the original
  // back clears the band: the band means "this row differs", not "the model touched it".
  div.classList.toggle('wbchanged', /** @type {HTMLTextAreaElement} */ (ta).value !== original);
}

/**
 * @param {string} kind
 * @param {number} index
 * @param {string} review - `'approved'`/`'rejected'`/`'edited'`.
 * @param {string} [edited] - the hand-edited text, when `review` is `'edited'`.
 */
export async function wbReview(kind, index, review, edited) {
  const st = wbState(kind);
  const p = await jpost(
    `/wbedit/pass/${encodeURIComponent(st.doc.id)}/${encodeURIComponent(st.pass.id)}/proposal/${index}/review`,
    edited == null ? { review } : { review, edited },
  );
  const div = /** @type {VEl} */ (wbEl(kind, 'wbProposals')).querySelector(`.wbprop[data-index="${index}"]`);
  if (div) wbMarkVerdict(div, p.review);
}

// The saved-instruction dropdown. It moved WITH the pass rather than being left behind: `wbFinish`
// calls it to refresh the list after a run, and a module cannot reach a function still sitting in
// the inline script — the bridge runs one way only. Its own callers (`wbLoadLib` and the two
// Save/Delete handlers) reach it back through the shim.
/**
 * One row of `/wbedit/instructions`, saved and reusable across documents of the same kind.
 * @typedef {Object} WbInstruction
 * @property {string} id
 * @property {string} text
 * @property {string} [name]
 * @property {boolean} [favorite]
 * @property {unknown[]} [runs] - past uses; only its `.length` is read here.
 */

/** @param {string} kind */
export async function wbLoadInstructions(kind) {
  try {
    const r = await jget('/wbedit/instructions?kind=' + encodeURIComponent(wbDocKind(kind)));
    const sel = /** @type {VEl} */ (wbEl(kind, 'wbInsPick'));
    /** @type {WbInstruction[]} */
    const instructions = r.instructions;
    sel.innerHTML =
      '<option value="">— saved instructions —</option>' +
      instructions
        .map(
          i =>
            `<option value="${esc(i.id)}">${i.favorite ? '★ ' : ''}${esc(i.name || i.text.slice(0, 50))}` +
            `${i.runs && i.runs.length ? ' · used ' + i.runs.length + '×' : ''}</option>`,
        )
        .join('');
    sel._items = instructions;
  } catch (e) {
    /* a locked vault is already reported by the library pane */
  }
}
