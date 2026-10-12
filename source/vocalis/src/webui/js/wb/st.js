/** Own SillyTavern pull/push operations and their sweep and send pollers. This module depends on the editor and library modules. Export the poll maps used by browser specs to verify per-pane state.
 */
import { modal } from '../ui/modal.js';
import { wbEl } from '../util/dom.js';
import { jdel, jget, jpost } from '../util/http.js';
import { wbLoadBookFilter, wbLoadLib, wbSaveEdits } from './open.js';
import { registerWbAction, wbSay } from './say.js';
import { wbState } from './state.js';

// The Vocalis Library owns the send/import controls. Vocalis cannot call SillyTavern's API without
// a logged-in session; storing the SillyTavern password is not appropriate. Instead, this module
// queues a request that the paired extension collects with its existing session and token.
//
// Report when no SillyTavern tab is available so the user can open one.
// Keep one poll per pane (5.4). A single module global shared by
// `cards`, `books` and `personas` — all three wired through the same `wbWire(kind)`. Start an
// import on Cards, then start one on Books: the second `clearInterval` killed the FIRST pane's
// poller. Because `wbSay(…, 'busy')` intentionally has no timeout (see `wbSay`), each pane must
// own its own poll; keying by `kind` keeps concurrent imports independent.
/** @type {Record<string, ReturnType<typeof setInterval>>} */
export const wbSweepPoll = {};

// 🔴 A CALLER THAT NEEDS TO KNOW WHEN THE IMPORT *ENDED*, WHICH IS NOT WHEN THIS FUNCTION RETURNS.
// `wbStSweep` resolves as soon as the poller is armed — the import itself finishes somewhere in
// the next 2s..10min, inside a `setInterval` that nothing outside this file can see. That was fine
// while the only caller was a button, and it is not fine for `Undelete` (9.7.1), which has to put
// the recycle-bin row BACK if the import never brought the document back.
//
// ⚠️ EXACTLY ONE CALL PER WAITER, ON EVERY TERMINAL PATH, INCLUDING CANCEL. A callback that fires
// twice would re-dismiss a ref that had already come back; one that never fires leaves `Undelete`
// spinning over a row it disabled. `finishSweep` takes the pending list before invoking it, so
// both are structural rather than remembered.
//
// 🔴 A SECOND SWEEP INHERITS THE FIRST'S WAITERS — IT DOES NOT END THEM, AND THE DIFFERENCE IS A
// BUG THAT WOULD HAVE SHIPPED. The obvious spelling finishes the pending callback at the top of
// `wbStSweep`, on the reasoning that `clearInterval` has just killed the poller that would have
// called it. But the caller pressing ⟳ Import while an `Undelete` is in flight is not rare — it is
// what someone does when a row has been saying "asking SillyTavern for it…" for ten seconds — and
// finishing the waiter there rolls the ref back into `dismissed` while the NEW sweep is still
// running. `is_dismissed` then declines the very document the new sweep was about to bring back.
// Inheriting is both simpler and right: the waiter rides the newer import and gets its real
// outcome. The list can only be emptied by a terminal state.
/** @type {Record<string, ((r: any) => void)[] | undefined>} */
const sweepDone = {};

/**
 * End every pending completion callback for `kind`. Safe to call on a pane that has none.
 * @param {string} kind
 * @param {any} r - the sweep's own `last` record, or a `{canceled}`/`{unasked}`/`{silent}` marker
 */
function finishSweep(kind, r) {
  const waiting = sweepDone[kind] || [];
  delete sweepDone[kind];
  waiting.forEach(fn => fn(r || {}));
}

/**
 * @param {string} kind
 * @param {(r: any) => void} [done] - called once when the import reaches a terminal state, with
 *   the server's `last` record (or a marker). See `finishSweep`.
 */
export async function wbStSweep(kind, done) {
  clearInterval(wbSweepPoll[kind]);
  if (done) sweepDone[kind] = (sweepDone[kind] || []).concat(done);
  let st;
  try {
    st = await jpost('/wbedit/st-sweep', {});
  } catch (e) {
    wbSay(kind, /** @type {ErrLike} */ (e).status === 423 ? 'Vocalis is locked — log in first.' : 'could not ask for an import', true);
    finishSweep(kind, { unasked: true });
    return;
  }
  // 🔴 A TAB THAT HAS NOT POLLED YET IS NOT A MISSING TAB, AND THIS USED TO CONFLATE THEM.
  // `connected` only turns true once a poll lands, and the extension polls every 5s — so pressing
  // this within five seconds of unlocking Vocalis (which is exactly when he WOULD press it, having
  // just logged in to get here) answered "no SillyTavern tab is listening" over a tab sitting
  // right there. The request is already recorded by the POST above, so the honest thing is to wait
  // one poll window before concluding anything.
  wbSay(kind, st.connected ? 'asked SillyTavern for everything — importing…' : 'waiting for SillyTavern…', 'busy');

  // Poll until the extension reports. `running` only goes true once it has CLAIMED the sweep, so
  // a request that is still pending is not yet a run — and the server ages an abandoned one out
  // rather than leaving this spinning forever.
  let waited = 0,
    queued = false;
  wbSweepPoll[kind] = setInterval(async () => {
    waited += 2;
    let s;
    try {
      s = await jget('/wbedit/st-sweep');
    } catch (e) {
      return;
    }
    if (!s.pending && !s.running) {
      clearInterval(wbSweepPoll[kind]);
      const r = s.last || {};
      // 7.0-m4w — an uncollected request now ends with a reason instead of silently leaving the
      // PREVIOUS import's tally on screen ("imported 12 books" for an import that never ran).
      if (r.expired) {
        wbSay(kind, r.reason, 'bad');
        finishSweep(kind, r);
        return;
      }
      const bits = [];
      if (r.books) bits.push(r.books + ' book' + (r.books === 1 ? '' : 's'));
      if (r.cards) bits.push(r.cards + ' character' + (r.cards === 1 ? '' : 's'));
      if (r.personas) bits.push(r.personas + ' persona' + (r.personas === 1 ? '' : 's'));
      if (r.unchanged) bits.push(r.unchanged + ' unchanged');
      // 🔴 NAME WHAT FAILED. A count alone ("3 failed") is a message he can do nothing with, and
      // a book that silently did not arrive is worse than one that says it did not.
      const failed = (r.failed || []).length ? ' · could not read: ' + r.failed.join(', ') : '';
      wbSay(kind, (bits.length ? 'imported ' + bits.join(', ') : 'nothing to import') + failed, (r.failed || []).length ? 'bad' : 'ok');
      await wbLoadLib(kind);
      if (kind === 'cards') wbLoadBookFilter(); // §8.2 — new books, new filter options
      // ⚠️ AFTER the reload, not before: `Undelete`'s callback asks the server whether its
      // document is back and then re-renders, so firing this first would race its own repaint.
      finishSweep(kind, r);
      return;
    }
    // A tab that picked the request up after waiting: take the "queued" line back down.
    if (s.running && queued) {
      queued = false;
      wbSay(kind, 'asked SillyTavern for everything — importing…', 'busy');
      return;
    }
// A hidden tab's timer can be throttled to once a minute, longer than the 16-second liveness window.
// Do not treat a hidden-but-open tab as missing.
    if (!s.connected && !s.running && waited >= 14 && !queued) {
      queued = true;
      wbSay(
        kind,
        'SillyTavern’s tab is in the background — queued, it will import as soon as it ' +
          'checks in. Switching to that tab starts it immediately.',
        'busy',
        { label: 'Cancel', fn: 'wbStSweepCancel' },
      );
      return;
    }
    // Backstop only. The server ends an uncollected request with a reason at `sweep.PENDING_S`
    // (10 min) and a claimed run at `STALE_RUN_S` (5 min), so the terminal branch above is what
    // normally fires. This is here in case the status route itself stops answering.
    if (waited > 960) {
      clearInterval(wbSweepPoll[kind]);
      wbSay(kind, 'SillyTavern never reported back — is the tab still open?', true);
      finishSweep(kind, { silent: true });
    }
  }, 2000);
}

/** Cancel a queued import before a tab collects it; unlike a send, it writes no document. */
/** @param {string} kind */
export async function wbStSweepCancel(kind) {
  clearInterval(wbSweepPoll[kind]);
  // 🔴 BEFORE the `await`, and that ordering is the whole reason this is not one line lower. The
  // callback's job on this path is to put an `Undelete`'d row back in the bin; leaving it until
  // after a network round trip leaves the row disabled and mid-gesture for as long as that takes.
  finishSweep(kind, { canceled: true });
  try {
    await jdel('/wbedit/st-sweep');
  } catch (e) {
    /* it will age out of the UI regardless */
  }
  wbSay(kind, 'import canceled.', 'ok');
}

// ── 7.0-m3: "Send to SillyTavern" ────────────────────────────────────────────────────────────
// This queues an import into SillyTavern's live document; the paired extension performs the write.
//
// ⚠️ VOCALIS CANNOT PERFORM THE WRITE, for the same reason it cannot perform the import: no
// SillyTavern session, and it is not storing his password to get one. So this records a job and
// the extension collects it within a poll — the identical shape as the sweep above, deliberately,
// because a second mechanism for the same constraint is a second thing to keep in step.
//
// Explain unsendable content before queuing the write. A mirrored lorebook is reported during the
// send because SillyTavern's next save can overwrite it.
// Per pane, for the same reason `wbSweepPoll` is (5.4).
/** @type {Record<string, ReturnType<typeof setInterval>>} */
export const wbSendPoll = {};

/** @param {string} kind */
export async function wbStSend(kind) {
  const st = wbState(kind);
  if (!st.doc || !st.rev) {
    wbSay(kind, 'Open a document first.', true);
    return;
  }
// §9a.27 — Ask before sending a revision that differs from the open editor. This send uses the
// open, saved revision (deliberately — see below), and has never checked for unsaved
// hand edits. With edits on screen it would write the version without them and report success
// about a revision different from the one displayed.
  //
// Keep this check beside the Save control so the two actions remain distinct.
  //
// Never send silently or auto-save. Saving on the user's behalf mints a revision they did not ask
  // for; sending silently is the bug. Asking is the only answer that keeps both rules.
// Do not disable Save to SillyTavern: the document can be overwritten in SillyTavern's client,
// so "Vocalis
  // already sent this" is not evidence about what is over there now.
  if (wbEl(kind, 'wbFields') && /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelector('.wbdirty')) {
    const go = await modal(
      'You have unsaved edits',
      '<p>Save to SillyTavern writes the revision that is <b>saved in Vocalis</b> — and your edits ' +
        'on screen are not in it yet, so SillyTavern would get the version <i>without</i> them.</p>' +
        '<p class="small muted">Save as new revision first, then send that.</p>',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Send the saved revision anyway', value: 2 },
        { label: 'Save, then send', class: 'primary', value: 1 },
      ],
    );
    if (!go) return;
    if (go === 1) {
      await wbSaveEdits(kind, wbEl(kind, 'wbSaveTop'));
      // The save re-opens the document, so `st.rev` is the new revision by the time we send. Bail
      // if it did not take — a refused save (§9a.29a's 422, or a 409) has already said why, and
      // sending on top of that message would bury it.
      if (/** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelector('.wbdirty')) return;
    }
  }
  // 🔴 5.3 — DO NOT KILL THE RUNNING POLLER UNTIL THIS PRESS HAS ACTUALLY CLAIMED THE SEND. The
  // `clearInterval` used to sit HERE, above the POST. Double-press ⬆ Save to SillyTavern and the
  // second press stopped the first press's poller, then got a 409 (a send is already in flight),
  // showed it in red and returned — while the real write went on to complete in SillyTavern with
  // NOTHING left watching for it. No success, no failure, a pane that never said anything again.
  // The poller is now torn down only once we know this press owns the send.
  let s;
  try {
    // 🔴 THE REVISION IS THE OPEN ONE, never the latest — sending an older revision is how an
    // overwrite in SillyTavern gets undone (§8), the same rule Export keeps.
    s = await jpost('/wbedit/documents/' + encodeURIComponent(st.doc.id) + '/send?revision=' + st.rev.n, {});
  } catch (e) {
    // 400 is `Unsendable` — a sentence written for him about THIS document ("assemble it first",
    // "this card was never imported from SillyTavern"). It is the whole value of building the
    // plan on the press, so it must not be flattened into a generic failure.
    const why =
      /** @type {ErrLike} */ (e).body && /** @type {ErrLike} */ (e).body.error
        ? /** @type {string} */ (/** @type {ErrLike} */ (e).body.error)
        : /** @type {ErrLike} */ (e).status === 423
          ? 'Vocalis is locked — log in first.'
          : 'could not ask for a send';
    wbSay(kind, why, true);
    return;
  }
// Do not show `dropped` in the success message. The only omitted field is a mirrored lorebook,
// which `formats/card.py` does not expose as editable content; the server still records and logs it.
// 9.5.17 — Report when the tab is running an old extension copy before the user waits on it.
  // The extension is a hand-copied directory and a long-lived tab keeps whatever JS it loaded, so
  // a feature added since that load is simply absent — which reads as a broken button rather than
// as a stale tab. An old copy cannot report the feature, so explain that state on the press.
  //
  // ⚠️ SHOWN ON THE PRESS, NOT IN THE RESULT. By the time a result lands he has already decided
  // the feature is broken; the point is to name the cause while he is looking at the button.
  // Silent when `build` is empty — an extension too old to report one is not evidence of
  // anything, and guessing would be a false alarm on the first release after this ships.
  if (s.stale) {
    wbSay(
      kind,
      'SillyTavern is running an older copy of the Vocalis extension (' + s.build + ') — press Ctrl+Shift+R in that tab, then send again.',
      'bad',
    );
    return;
  }
  wbSay(kind, s.connected ? 'sending to SillyTavern…' : 'waiting for SillyTavern…', 'busy');

  // Now — the POST succeeded, so this press owns the send and replacing the watcher is correct.
  clearInterval(wbSendPoll[kind]);
  let waited = 0,
    queued = false;
  wbSendPoll[kind] = setInterval(async () => {
    waited += 2;
    let p;
    try {
      p = await jget('/wbedit/st-push');
    } catch (e) {
      return;
    }
    if (!p.pending && !p.running) {
      clearInterval(wbSendPoll[kind]);
      const r = p.last || {};
      if (r.ok) {
        // §6.3.2: confirm only after the extension verifies that SillyTavern applied the change.
        // §9a.33: a previously unseen card is created instead of rejected. Name it in the
        // confirmation because a merge may update a different existing document.
        //
        // Fall back to the old wording when `wrote` is absent; older extension tabs do not report
        // it, and a successful send must not render
        // "updated “”" because of it.
        // 9.5.18 — Name the kind and destination. A persona sent in card shape is filed as a card
        // (`detect.doc_kind` has no choice because the fields overlap), so the confirmation must say so.
        //
        // SillyTavern paginates this list at five (`personas.js`: `Number(accountStorage.getItem('Personas_PerPage')) || 5`).
        // The extension's `landed:true, filed:true` confirms the write; its creation path calls
        // `getUserAvatars(true, newRef)` to page the list to a new entry; that function is NOT on
        // `getContext()`, so the extension cannot, and saying so is the honest substitute.
        //
        // ⚠️ THE KIND COMES FROM THE PANE, NOT THE WIRE. A send always writes the document open in
        // THIS pane, so `kind` already IS the answer; reporting it over the wire as well would be
        // a second source for a fact in hand, which is how two sources come to disagree.
        const noun = kind === 'personas' ? 'persona' : kind === 'books' ? 'World Book' : 'character';
        const what = r.wrote ? ' \u201c' + r.wrote + '\u201d' : '';
        // Only on a CREATE, and only for a persona: a merge changes a row that is already wherever
        // it was, so the note there would be noise about a non-problem.
        const paged =
          r.created && kind === 'personas'
            ? ' \u2014 SillyTavern lists 5 personas per page, so a new one may be on the next page (\u203a)'
            : '';
        wbSay(
          kind,
          (r.created ? 'created the ' + noun + what : 'updated the ' + noun + what) +
            ' in SillyTavern' +
            (r.avatar ? ', picture and all' : '') +
            paged,
          'ok',
        );
      } else {
        // An expiry already reads as a whole sentence about what did NOT happen (`push._reap_locked`);
        // prefixing "send failed:" onto it just makes it longer than the line it has to fit in.
        wbSay(kind, r.expired ? r.reason : 'send failed: ' + (r.reason || 'SillyTavern did not say why'), 'bad');
      }
      return;
    }
    // A tab that picked the job up after waiting: take the "queued" line back down.
    if (p.running && queued) {
      queued = false;
      wbSay(kind, 'sending to SillyTavern…', 'busy');
      return;
    }
    // A hidden tab is not a missing tab. The extension polls every 5s, but a browser throttles a
    // hidden tab's setInterval to once a minute. Against a 16s liveness window that can never be
    // satisfied, so the job remains queued for an explicit cancel or server expiry.
    // Explicit cancellation withdraws a potentially stale write. Otherwise, keep the job queued,
    // offer Cancel, and let the server expire it at `push.PENDING_S` (10 min) with a result.
    if (!p.connected && !p.running && waited >= 14 && !queued) {
      queued = true;
      wbSay(
        kind,
        'SillyTavern’s tab is in the background — queued, it will go as soon as it ' +
          'checks in. Switching to that tab sends it immediately.',
        'busy',
        { label: 'Cancel', fn: 'wbStSendCancel' },
      );
      return;
    }
    // Backstop only. The server now ends every send with a result — `push.PENDING_S` for a job
    // nobody collected, `STALE_RUN_S` for a run that never reported — so the terminal branch above
    // is what normally fires. This is here in case the status route itself stops answering.
    if (waited > 660) {
      clearInterval(wbSendPoll[kind]);
      wbSay(kind, 'SillyTavern never reported back — is the tab still open?', true);
    }
  }, 2000);
}

/** Cancel a queued send. Explicit cancellation is the only user action that withdraws it. */
/** @param {string} kind */
export async function wbStSendCancel(kind) {
  clearInterval(wbSendPoll[kind]);
  try {
    await jdel('/wbedit/st-push');
  } catch (e) {
    /* it ages out regardless */
  }
  wbSay(kind, 'send canceled — nothing was written to SillyTavern.', 'ok');
}

// 🔴 THE REGISTRY CLOSES HERE, AND THIS IS WHAT DELETES THE SHIM'S TRANSITIONAL BLOCK.
//
// `say.js` (7.1-m9) turned `WB_ACTIONS` into a registry precisely so that a message line could
// offer a Cancel button without `say.js` having to import — or even name — anything in this file.
// Until now nothing registered these two, so the shim at the bottom of `index.html` did it by hand
// with a pair of arrows deferring the lookup to click time. That block existed for exactly this
// module to arrive, and it is gone in the same commit.
//
// ⚠️ REGISTERED AT MODULE LOAD, WHICH IS THE WHOLE POINT OF THE INVERSION: the module that OWNS the
// function is the one that publishes it, so adding a third action never touches `say.js` again.
registerWbAction('wbStSweepCancel', wbStSweepCancel);
registerWbAction('wbStSendCancel', wbStSendCancel);

// 🔴 AND THE THIRD ACTION IS NOT FOR A MESSAGE LINE — IT IS `open.js` REACHING THIS MODULE WITHOUT
// IMPORTING IT (9.7.1). `st.js` already imports `open.js`, so `Undelete` calling `wbStSweep`
// directly would close exactly the cycle §5.5 forbids: it would work today by hoisting and break
// silently the day one of these becomes a `const` arrow. The registry is the inversion that was
// built for this, and using it costs one line.
registerWbAction('wbStSweep', wbStSweep);
