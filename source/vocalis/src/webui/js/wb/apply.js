/** Apply an approved pass and assemble a card from files. This module depends on `open.js` to refresh the roster and reopen the resulting revision; the dependency is one-way.
 */
import { wbConfirm } from '../ui/modal.js';
import { esc, wbEl } from '../util/dom.js';
import { jpost } from '../util/http.js';
import { wbLoadLib, wbOpen } from './open.js';
import { wbReview } from './pass.js';
import { wbHush, wbSay } from './say.js';
import { wbGen, wbStale, wbState } from './state.js';

/** @param {string} kind */
export async function wbApply(kind) {
  const st = wbState(kind);
  if (!st.doc || !st.pass) {
    wbSay(kind, 'Open a document and run a pass first.', true);
    return;
  }
  // 🔴 NOT IN THE REVIEW, AND THE WORST OF THIS FAMILY. Everything below used to read `st.doc` and
  // `st.pass` AFTER `await wbConfirm(...)` — and a confirm modal is arbitrarily long-lived, because
  // it waits for a human. The row list behind it is still live and still clickable, so clicking
  // another document while the modal is up moved `st.doc`, and the `materialize` POST then landed
  // on the NEW document carrying the OLD pass id. That is §1.1's shape (writing a change into a
  // document that is not the one it was computed from) reached by two clicks and a pause.
  //
  // The identity is pinned HERE, before the first await, and every await is followed by a
  // staleness check. `docId`/`passId` are then used for the whole function — `st.*` is not read
  // again after an await anywhere below.
  const seq = wbGen(kind),
    docId = st.doc.id,
    passId = st.pass.id,
    docName = st.doc.name;
  // Hand-edits in the review pane are sent first: a textarea changed without pressing ✓ on
  // is still his decision, and losing it to a button-press order would be indefensible.
  const rows = [.../** @type {VEl} */ (wbEl(kind, 'wbProposals')).querySelectorAll('.wbprop')];
  for (const div of rows) {
    if (/** @type {HTMLElement} */ (div).dataset.review === 'rejected') continue;
    const ta = div.querySelector('.wbedited');
    if (ta && /** @type {HTMLTextAreaElement} */ (ta).value !== /** @type {HTMLTextAreaElement} */ (ta).defaultValue)
      await wbReview(
        kind,
        +(/** @type {string} */ (/** @type {HTMLElement} */ (div).dataset.index)),
        'edited',
        /** @type {HTMLTextAreaElement} */ (ta).value,
      );
    if (wbStale(kind, seq)) return;
  }
  const willApply = rows.filter(d => /** @type {HTMLElement} */ (d).dataset.review !== 'rejected').length;
  if (
    !(await wbConfirm(
      'Apply changes?',
      `<p>Apply <b>${willApply}</b> change${willApply === 1 ? '' : 's'} to ` +
        `<b>${esc(docName)}</b> as a new revision?</p>` +
        '<p class="small muted">Nothing is overwritten — the current revision stays exactly as it ' +
        'is, and you can roll back to it.</p>',
      'Apply',
    ))
  )
    return;
  // The check that matters: the user answered the modal, but they may have answered it about a
  // document they are no longer looking at.
  if (wbStale(kind, seq)) {
    wbSay(kind, 'Apply canceled — you moved to another document.', true);
    return;
  }
  try {
    const rev = await jpost(`/wbedit/pass/${encodeURIComponent(docId)}/${encodeURIComponent(passId)}/materialize`);
    // ⚠️ SAY IT EVEN IF THEY MOVED ON. The write HAPPENED; staying quiet because the pane now
    // shows something else is the same lie as reporting a success that did not happen, pointed
    // the other way — and this whole review batch exists because of that class of bug.
    wbSay(kind, `applied ${rev.applied} change${rev.applied === 1 ? '' : 's'} — revision ${rev.n}`);
    // The screen work, though, is only correct if they are still on that document.
    if (wbStale(kind, seq)) return;
    /** @type {VEl} */ (wbEl(kind, 'wbReview')).style.display = 'none';
    await wbLoadLib(kind);
    if (wbStale(kind, seq)) return;
    await wbOpen(kind, docId);
  } catch (e) {
    wbSay(kind, /** @type {ErrLike} */ (e).message || 'nothing was approved', true);
  }
}
// 🔴 `wbConfirm` AND `wbAskName` NOW LIVE IN `js/ui/modal.js` (7.1-m8), with the dialogs
// they are built on. `prompt.js` needs both and cannot reach an inline function, but that
// is the trigger rather than the reason: they are called from a dozen places across the
// editor, so parking them in whichever module moved next would make that module a
// dependency of everything. The callers below reach them through the shim.

/**
 * @param {string} kind
 * @param {File[]} files - the chunk files he picked, spread from a `<input type=file>`'s `FileList`.
 * @param {string} name - the assembled book's name; a falsy value is a no-op (the caller canceled).
 */
export async function wbAssemble(kind, files, name) {
  if (!name) return;
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  fd.append('name', name);
  wbSay(kind, `assembling ${files.length} section${files.length === 1 ? '' : 's'}…`, 'busy');
  const r = await fetch('/wbedit/assemble', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // 🔴 EVERY 'busy' NEEDS A TERMINAL — it has no timeout by design, so an early return leaves a
    // spinner turning over a job that ended. The errors go in the box below, so this line's work
    // is done and it goes away rather than being restated in red.
    wbHush(kind);
    // 🔴 ERRORS ABORT AND NOTHING IS FILED — an entry that can never fire is invisible in
    // SillyTavern until a scene silently lacks its lore. Show them all, not just the first.
    const box = /** @type {VEl} */ (wbEl(kind, 'wbLib'));
    /** @type {string[]} */
    const errors = j.errors || [];
    box.innerHTML =
      '<div class="wbbad"><b>' +
      esc(j.error || 'assembly failed') +
      '</b></div>' +
      '<ul class="small wbbad">' +
      errors.map(e => '<li>' + esc(e) + '</li>').join('') +
      '</ul>' +
      '<div class="small muted">Nothing was added to the library. Fix the chunks and try again.</div>';
    return;
  }
  await wbLoadLib(kind);
  wbSay(kind, `assembled ${files.length} section${files.length === 1 ? '' : 's'}`, 'ok');
  wbShowReport(kind, j.report);
  wbOpen(kind, j.id);
}

/**
 * The budget analysis `/wbedit/assemble` returns alongside a successful import.
 * @typedef {Object} WbAssembleReport
 * @property {number} entries
 * @property {{file: string, entries: number}[]} sections
 * @property {number} constant_tokens
 * @property {number} constant_budget
 * @property {number} worst_tokens
 * @property {number} wi_budget
 * @property {string} [worst_key]
 * @property {string[]} warnings
 */

// §6.5: the budget analysis is "a genuine will-this-book-work-in-context preflight, and today it
// scrolls past in a terminal. In the UI it is a HEADLINE, not a log line."
/**
 * @param {string} kind
 * @param {WbAssembleReport} [rep]
 */
function wbShowReport(kind, rep) {
  if (!rep) return;
  /** @param {number} a @param {number} b */
  const over = (a, b) => b && a > b;
  /** @param {number} a @param {number} b */
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const box = /** @type {VEl} */ (wbEl(kind, 'wbLib'));
  // 🔴 ONE REPORT, NOT A STACK. This inserted a fresh panel per assemble and removed nothing, so
  // three assembles left three reports piled under the library — the oldest at the top, all of
  // them looking equally current, and the LAST one never cleared at all. Marked with a class so
  // there is something to find it by; the node was previously anonymous, which is why the first
  // version of this had nothing it could remove.
  const prev = /** @type {ParentNode} */ (box.parentNode).querySelector('.wbreport');
  if (prev) prev.remove();
  const head = document.createElement('div');
  head.className = 'panel wbreport';
  head.style.marginTop = '10px';
  head.innerHTML = `<b>Assembled ${rep.entries} entries from ${rep.sections.length} sections</b>
    <div class="row" style="gap:18px;margin:8px 0">
      <div><div class="small muted">constant footprint</div>
        <div class="${over(rep.constant_tokens, rep.constant_budget) ? 'wbbad' : ''}">~${Math.round(rep.constant_tokens)} / ${rep.constant_budget} tokens (${pct(rep.constant_tokens, rep.constant_budget)}%)</div></div>
      <div><div class="small muted">worst-case concurrency${rep.worst_key ? ' — key "' + esc(rep.worst_key) + '"' : ''}</div>
        <div class="${over(rep.worst_tokens, rep.wi_budget) ? 'wbbad' : ''}">~${Math.round(rep.worst_tokens)} / ${rep.wi_budget} tokens (${pct(rep.worst_tokens, rep.wi_budget)}%)</div></div>
    </div>
    <div class="small muted">${rep.sections.map(x => esc(x.file) + ' (' + x.entries + ')').join(' · ')}</div>
    ${rep.warnings.length ? '<details style="margin-top:8px"><summary class="small">' + rep.warnings.length + ' warning(s)</summary><ul class="small muted">' + rep.warnings.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul></details>' : '<div class="small muted" style="margin-top:6px">No warnings.</div>'}`;
  /** @type {ParentNode} */ (box.parentNode).insertBefore(head, box.nextSibling);
}
