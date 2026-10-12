// voice/candidates.js — the Create-a-voice candidate queue (7.3-m4).
//
// The append-only list of drawn voices under the Create tab: loading it, rendering it, wiring its
// players, and the ✓ Save / ✕ Delete gestures that take a row out of it. Moved verbatim from
// index.html's `── Create a voice ──` banner. This module owns the durable candidate list and its
// save, delete, pagination, playback, and recovery behavior.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS SUB-SLICE, RATHER THAN THE WHOLE 1,030-LINE CREATE-A-VOICE AREA.
//
// Because the area is really three things that happen to share a tab — the DESIGN form (language,
// length, templates, the Generate button), the overnight BATCH, and this QUEUE — and only the
// queue is load-bearing for what comes next. It is also the cleanest boundary in the area: eleven
// functions, three names reaching back out, and not one parse-time caller.
//
// 📌 The remaining two thirds move under their own milestones. `vc` stays declared inline until
// they do, because all three share it — see below.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — three, and every one has a named inline caller at RUNTIME.
//
//   vcN               the "1 voice / 2 voices" pluralizer. Called by the Generate button's
//                     handler and by the batch's confirm dialog.
//   vcPoll            the generation-status poll. Started by the Generate button.
//   loadCandidates    called by switchVTab on entering the tab, and by vcBatchPoll when a batch
//                     round lands.
//
// 🔴 THE OTHER EIGHT ARE MODULE-PRIVATE TO THE PAGE AND SLICED BY A HARNESS. renderCandidates,
// vcRenderCandHead, vcRowHTML, vcClipDead, vcWirePlayback, vcAnyPlaying, promptVoiceName and
// vcDelete have no inline caller left — but `tests/voices_ui_smoke.mjs` slices all of them out of
// the real source and runs them under `vm`, so they are exported anyway. A spec caller is a
// caller: that is the rule `tests/test_webui_modules.py` computes, and js/sys/devices.js is where
// it was first learned the hard way.
//
// ⚠️ Exporting them is safe under the shim's eligibility rule — all eleven are `function`
// declarations, never reassigned, so `Object.assign` copying a value once cannot go stale.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE STILL REACHES FOR AS AN INLINE GLOBAL — two names, both at CALL time.
//
//   vcSyncModel     shows/hides the Create tab against what the model reports. `vcPoll` calls it
//                   on a terminal status; js/sys/model.js reaches for it too, and its header
//                   already files it as "→ voices/create.js".
//   loadVoiceList   repaints the Voices panel below after a save. Moves with that panel.
//
// ✅ `vc` USED TO BE THE THIRD AND IS AN IMPORT AS OF 7.3-m8a. This header said it "moves when the
// LAST of the three does, not with the first" — the three being the design form, this queue and the
// overnight batch. It moved on its own instead, into js/voice/design.js, because letting it travel
// with the form would have made `voices/*` declare it while importing `loadCandidates`/`vcN`/
// `vcPoll` from here: a cycle. One file all three import has none.
//
// ⚠️ DO NOT REDECLARE `vc` HERE. Exactly one declaration: a second copy would mean this file
// mutates its own while the design form and the batch read one nothing updates — the same trap
// §11.4 documents for MODELS/ENCRYPTED, and the reason those stayed inline too.
//
// 📌 `loadVoices` IS an import, not a reach — it became js/sys/devices.js in this same milestone,
// and the save path calls it to refresh every voice dropdown once a candidate becomes a voice.
//
// ⚠️ AND SO IS `promptForName`, WHICH THE FIRST CUT OF THIS FILE MISSED. It sat here as a bare
// global and WORKED, because js/ui/modal.js is on the shim's `Object.assign` — so nothing threw,
// nothing went red, and the count of reaches above quietly said three when it was four. A name
// that resolves through the shim by accident is a name whose module can never leave the shim:
// `modal` was imported from the same file two lines up. Import both, and the list above is true.

import { $, esc } from '../util/dom.js';
import { jget, jpost } from '../util/http.js';
import { fmtSize, fmtDate } from '../util/fmt.js';
import { modal, promptForName } from '../ui/modal.js';
import { loadVoices } from '../sys/devices.js';
import { vc } from './design.js';
// 🔴 BOTH WERE FREE NAMES. `vcSyncModel` is called on `vcPoll`'s two terminal arms (:79 the reaped
// -404 path, :84 the finished path) and `loadVoiceList` on the save-candidate path (:670) — all
// three survived m8b's move of voices.js out of the page as bare reads that the shim resolved
// through `window`. Since m13 they resolve to nothing: a finished Create-a-voice job threw before
// writing `#vcStatus`, so the candidates never appeared, and a successful save raised a second
// modal reading "Save failed — loadVoiceList is not defined". The poll and save paths must both resolve these imports.
import { vcSyncModelFire, voiceListLoad } from '../voices/vcstate.js'; // 7.5.6 — the leaf
// "1 voice" / "2 voices" — digits, because these are counts the user is waiting on.
/** @param {number} n @param {string} noun */
export function vcN(n, noun) {
  return n + ' ' + noun + (n === 1 ? '' : 's');
}
export async function vcPoll() {
  if (!vc.job) return;
  let s;
  try {
    s = await jget('/voices/design/status/' + vc.job);
  } catch (e) {
    // 404 = the job is gone; anything else = retry
    if (/** @type {ErrLike} */ (e).status === 404) {
      vc.busy = false;
      vc.job = null;
      vcSyncModelFire();
      /** @type {VEl} */ ($('vcStatus')).textContent = '';
      return;
    }
    vc.timer = setTimeout(vcPoll, 1000);
    return;
  }
  if (s.log && s.log.length) {
    /** @type {VEl} */ ($('vcLog')).style.display = '';
    /** @type {VEl} */ ($('vcLog')).textContent = s.log.join('\n');
    /** @type {VEl} */ ($('vcLog')).scrollTop = /** @type {VEl} */ ($('vcLog')).scrollHeight;
  }
  if (s.status === 'running') {
    vc.timer = setTimeout(vcPoll, 800);
    return;
  }
  vc.busy = false;
  vc.job = null;
  vcSyncModelFire(); // terminal
  // The job's candidate list is used ONLY to word the message. The ROWS come from the server
  // (§18.5): this draw's output plus everything that was already there — which is the point of
  // append-only, and is also how a batch running with this tab closed shows up here at all.
  const n = (s.candidates || []).length;
  if (s.status === 'canceled') {
    /** @type {VEl} */ ($('vcStatus')).textContent =
      'Canceled.' + (n ? ` ${vcN(n, 'candidate')} finished before the cancel — ${n === 1 ? 'it’s' : 'they’re'} in the list below.` : '');
  } else if (s.status === 'failed' || !n) {
    /** @type {VEl} */ ($('vcStatus')).innerHTML =
      s.errors && s.errors.length ? '<span class="drop">' + esc(s.errors.join('; ')) + '</span>' : 'Generation produced nothing.';
  } else {
    /** @type {VEl} */ ($('vcStatus')).textContent =
      n > 1
        ? `${vcN(n, 'voice')} added — audition them and keep any, all, or none.`
        : 'Added below. Audition it and Save it if you like it, or Generate again for a new draw.';
    if (s.errors && s.errors.length)
      /** @type {VEl} */ ($('vcStatus')).innerHTML += ' <span class="drop">' + esc(s.errors.join('; ')) + '</span>';
  }
  loadCandidates();
}
// The list, from the server. Called after anything that can change it: a draw finishing, a
// delete, a save, a batch round landing, and entering the tab.
export async function loadCandidates() {
  /** @type {{candidates: import('./design.js').VcCandidate[], total_bytes: number}} */
  let j;
  try {
    j = await jget('/voices/design/candidates');
  } catch (e) {
    return;
  } // a transient failure must not blank a durable list
  const fresh = j.candidates || [],
    known = new Set(vc.cands.map(c => c.token));
  const wasPlaying = vcAnyPlaying() && vc.cands.length;
  vc.cands = fresh;
  vc.total = j.total_bytes || 0;
  // Forget selections whose row is gone — deleted here or in another browser.
  // Without this the "3 selected" counter outlives the rows and Delete selected sends tokens
  // that no longer exist.
  const live = new Set(fresh.map(c => c.token));
  [...vc.sel].forEach(t => {
    if (!live.has(t)) vc.sel.delete(t);
  });
  // ↩ And the same for the recycle bin: a clip the server no longer has is not recoverable, and
  // holding its token would leave ↩ Undelete last enabled over a row that could never come back.
  // This can happen when another browser commits its recycle bin.
  vcBin.tokens = vcBin.tokens.filter(t => live.has(t));
  // 🔴 A REFRESH MUST NOT CUT OFF THE CLIP HE IS AUDITIONING. renderCandidates assigns
  // innerHTML, which destroys every <audio> element in the box — so with a batch landing a
  // round every 30–60 s, reviewing the list WHILE it runs would stop the playback roughly once
  // a minute. That is precisely when he is reviewing, so the common case is the broken one.
  //
  // While something is playing, only the genuinely NEW rows are prepended and nothing already on
  // screen is touched. The trade is that rows deleted in another window linger until the next
  // full render — visible and harmless, where a silent cut-off is neither.
  if (wasPlaying) {
    // ↩ …and a binned row is not "new", however new the server thinks it is. ⚠️ `known` happens to
    // exclude it today as well, because a token can only be binned while it is in `vc.cands` and
    // nothing takes it out of there — so this filter is currently belt-and-braces. It is here
    // because the rule being kept is "no path draws a binned row", which is a property of this
    // path, and not "binned implies known", which is a property of somewhere else.
    const added = fresh.filter(c => !known.has(c.token) && !isBinned(c.token));
    // 🔴 ONLY ONTO PAGE 1 (7.3-m4f). New candidates are prepended, so they belong at the top of the
    // FIRST page — pushing them onto page 4 would put row 1 above row 151 and every row on screen
    // would then be one out of step with the "showing 151–200" line above it. On any other page the
    // arrival is silent here and shows up in the header's count, which is the honest report: the
    // list grew, and the page you are reading did not move under you.
    if (added.length && !vc.page) /** @type {VEl} */ ($('vcCandidates')).insertAdjacentHTML('afterbegin', added.map(vcRowHTML).join(''));
    // 🔴 §17.4 — AND ROWS THAT ARE GONE MUST GO. The route can delete a clip while it is playing,
    // but this path only ever PREPENDED, so the row stayed on screen and the button read as dead.
    // A stale row from another window is harmless, but keeping a row after the current delete
    // makes the control appear broken.
    //
    // Removed surgically, element by element, rather than by re-rendering: a full render is the
    // very thing this branch exists to avoid, because it destroys every <audio> and cuts off the
    // clip he is auditioning. Removing a row he did not ask about cannot interrupt him — and if
    // the row he deleted IS the one playing, stopping it is exactly what he asked for.
    // ↩ `!live.has` OR binned — the two reasons a row on screen should not be. The bin case is the
    // one that reaches this branch in practice: ✕ during playback re-renders through vcBinDelete,
    // and this sweep is what keeps a row from surviving a refresh that lands after it.
    /** @type {VEl} */ ($('vcCandidates')).querySelectorAll('[data-vccard]').forEach(el => {
      const t = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.vccard);
      if (!live.has(t) || isBinned(t)) el.remove();
    });
    vcWirePlayback(/** @type {VEl} */ ($('vcCandidates'))); // idempotent — only the new elements get listeners
    vcRenderCandHead();
    return;
  }
  renderCandidates();
}
// ─────────────────────────────────────────────────────────────────────────────────────────
// ↩ UNDELETE LAST — a one-slot recycle bin (7.3-m4e).
//
// So a ✕ gesture stops being immediate. The rows leave the list at once — the gesture has to feel
// like a delete or it is a worse control — but nothing is sent to the server. The NEXT ✕ gesture is
// what commits the previous one, and takes its place in the bin. One level of undo, which is
// exactly what an accidental click needs and all it needs.
//
// 🔴 THE BIN HOLDS ONE **DELETION**, NOT ONE CLIP. `✕ Delete selected` with twenty rows ticked is
// one gesture, and it is the accident most worth undoing, so all twenty come back together.
//
// 🔴 SAVE DOES NOT FILL IT. Saving deletes the candidate on purpose — that is 7.2-m5's rule, and
// the clip's bytes now live inside a real voice. Offering to resurrect a candidate whose voice
// already exists is a confusing state, not a safety net. The bin is for the ✕ gestures only, which
// is why `vcDelete` below still means "delete, now, for real" and the ✕ buttons call `vcBinDelete`.
//
// ✅ CLIENT-SIDE, AND NO BACKEND CHANGE — DELIBERATELY. The obvious build is a soft-delete on the
// server: a new route and a holding area. That is not the right first cut for this UI-only undo.
// It would be a `.py` change requiring a service restart, and a restart EVICTS THE VAULT KEY.
// A holding area for audio inside an encrypted-vault project is a design question about where those bytes live and
// whether they are routed, which is the class of thing that has leaked plaintext here before.
// Nothing is ever lost by deferring: a clip in the bin is simply a clip not yet deleted.
//
// ⚠️ THE RENDERING IS THE ACTUAL WORK, AND IT IS WHY THIS WAITED FOR THE MODULE. `loadCandidates`
// re-reads the list from the server, which is still the truth about a binned clip — so it comes
// straight back unless EVERY path that presents the list agrees to hide it. That is
// `renderCandidates`, the incremental prepend path, the removal sweep beside it, the header's
// counts and total, and Select all. `vcLive()` is the single answer all of them ask.
/** @type {{tokens: string[]}} */
export const vcBin = { tokens: [] };
/** @param {string} t */
const isBinned = t => vcBin.tokens.includes(t);

// The list AS PRESENTED: everything the server has, minus the deletion still sitting in the bin.
// 🔴 Read this instead of `vc.cands` anywhere the user is being shown or counted something. The one
// place that must NOT is `loadCandidates`'s bookkeeping, which is about what the server has.
export function vcLive() {
  return vc.cands.filter(c => !isBinned(c.token));
}

// Send the bin to the server for real. Its own function because three things call it: the next ✕
// gesture, the beforeunload at the bottom of this file, and nothing else — and the failure has to
// be reported by exactly one of them.
/** @param {string[]} tokens */
async function vcCommitBin(tokens) {
  if (!tokens.length) return true;
  try {
    await jpost('/voices/design/delete', { tokens });
  } catch (e) {
    await modal(
      'Delete failed',
      esc(/** @type {ErrLike} */ (e).message) +
        '<div class="small muted" style="margin-top:8px">The clips are still on disk, so their rows ' +
        'come back when the list next refreshes. Nothing was lost.</div>',
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    return false;
  }
  return true;
}

// The ✕ gestures. Defer THIS deletion, commit the PREVIOUS one.
//
// ⚠️ ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE. The rows leave and the bin is filled BEFORE the
// old bin goes to the server, so the click feels instant and — the part that actually matters —
// js/voice/autoplay.js sees the top row change at the moment of the click rather than one network
// round-trip later. Autoplay watches this list; a delete that repaints half a second late is a
// delete that advances half a second late, every time.
/** @param {string[]} tokens @param {boolean} ask */
export async function vcBinDelete(tokens, ask) {
  tokens = tokens.filter(Boolean).filter(t => !isBinned(t));
  if (!tokens.length) return;
  if (ask) {
    const bytes = vc.cands.filter(c => tokens.includes(c.token)).reduce((n, c) => n + (c.size || 0), 0);
    const go = await modal(
      'Delete candidates',
      `Delete ${vcN(tokens.length, 'candidate')} (${fmtSize(bytes)})? They leave the list now — ` +
        '<b>↩ Undelete last</b> brings them back until the next delete, which is what finally takes ' +
        'them off disk.',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Delete', class: 'danger', value: 1 },
      ],
    );
    if (!go) return;
  }
  const commit = vcBin.tokens;
  vcBin.tokens = tokens.slice();
  tokens.forEach(t => vc.sel.delete(t));
  // 🔴 §17.4 AGAIN, AND IT APPLIES TO THE DELETE ITSELF, NOT ONLY TO A REFRESH. renderCandidates
  // assigns innerHTML, which destroys every <audio> in the box — so deleting row 9 while row 1 is
  // playing would cut row 1 off. The old path got this for free by going through loadCandidates,
  // whose incremental branch removes rows surgically; deferring means this function repaints, so
  // it has to carry the same rule. Removing a row he did not ask about cannot interrupt him, and
  // if the row he deleted IS the one playing, stopping it is exactly what he asked for.
  if (vcAnyPlaying()) {
    /** @type {VEl} */ ($('vcCandidates')).querySelectorAll('[data-vccard]').forEach(el => {
      if (tokens.includes(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.vccard))) el.remove();
    });
    vcRenderCandHead();
  } else renderCandidates();
  if (!vcLive().length) /** @type {VEl} */ ($('vcStatus')).textContent = '';
  if (commit.length) {
    await vcCommitBin(commit);
    await loadCandidates(); // the server is the truth, including about a failed commit
  }
}

// Put them back. Nothing to undo on the server — that is the whole point of deferring — so this is
// a repaint and an empty bin.
//
// ⚠️ AND IT IS A FULL REPAINT, WHICH DOES STOP A CLIP THAT IS PLAYING — deliberately, unlike
// `vcBinDelete` above. Restoring rows means INSERTING them at their own positions in the middle of
// the list, and doing that surgically is a good deal of code for a case that barely arises: the
// gesture is "I just pressed ✕ by mistake", so the clip in question is either the one that was
// deleted (there is nothing to interrupt) or the one the delete already advanced to. The delete
// side is the one that had to be surgical, because ✕-ing rows while auditioning another IS the
// triage loop.
export function vcUndelete() {
  if (!vcBin.tokens.length) return;
  vcBin.tokens = [];
  renderCandidates();
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// PAGING — fifty at a time, with real controls at the bottom (7.3-m4f).
//
// 📌 THIS REPLACES THE RENDER CAP WITH A PAGE, WHICH IS THE SAME NUMBER DOING A BETTER JOB. §18.4's
// cap existed because several hundred <audio> elements in one DOM is genuinely heavy, and §17.4 put
// a Show all at the TOP because the one underneath a hundred players could not be found. Neither
// concern goes away: the cap is still a cap, Show all is still both places, and what is new is that
// rows 51–100 are now reachable without rendering rows 1–340 to get at them.
//
// 🔴 ONE FUNCTION OWNS THE ARITHMETIC. Four controls need these numbers — the rows, the top line,
// the footer, and the Prev/Next disabled states — and a second copy of `Math.ceil(n/size)` is how
// "Page 7 of 6" ships. It also CLAMPS, and writes the clamp back to `vc.page`: deleting the last
// row of the last page must land you on the new last page, not on an empty one with a Previous
// button as the only way to find out.
export function vcPages() {
  const list = vcLive();
  const size = Math.max(1, vc.show | 0);
  const all = size >= 1e9; // "Show all" — one page, however long
  const pages = all ? 1 : Math.max(1, Math.ceil(list.length / size));
  const page = Math.min(Math.max(0, vc.page | 0), pages - 1);
  vc.page = page;
  return {
    list,
    size,
    pages,
    page,
    all,
    from: all ? 0 : page * size,
    to: all ? list.length : Math.min(list.length, page * size + size),
  };
}

// The default, and the thing "Show all" toggles back to. Named rather than repeated, because it is
// in the markup's `vc` declaration too and the two must not drift.
export const VC_PAGE = 50;

// The selection bar. Its own function because a checkbox tick must repaint it WITHOUT repainting
// the rows — see the change handler further down — so the two callers would otherwise be two
// copies of the same four lines, which is how the count above the list and the count on the
// button drift apart. Declared HERE, above renderCandidates, so the pair slices out of the file
// together for tests/voices_ui_smoke.mjs.
export function vcRenderCandHead() {
  // 🔴 §17.4 — KEEP "SHOW ALL" AT THE TOP. There WAS a Show all — sitting
  // underneath a hundred rows of audio players, which is a control that exists and cannot be
  // found. The cap itself is right (§18.4: rendering several hundred <audio> elements is genuinely
  // heavy), so what was wrong was only ever where the way out lived.
  // 🔴 THE HEADER COUNTS WHAT IS ON SCREEN, NOT WHAT THE SERVER HAS. A binned row is presented as
  // deleted, so it must not be in the count — a list showing 19 rows above the words "20
  // candidates" is the header contradicting the thing it sits on top of.
  //
  // ⚠️ The total is `vc.total` MINUS the held bytes, not a sum of the visible rows. `total_bytes`
  // is the server's own figure for the store and is the number this line has always shown; re-
  // deriving it from the rows would quietly start reporting something slightly different the day
  // the two stop agreeing, and would hide that they had.
  const list = vcLive();
  const held = vc.cands.filter(c => isBinned(c.token)).reduce((n, c) => n + (c.size || 0), 0);
  /** @type {VEl} */ ($('vcCandTotals')).textContent =
    `${vcN(list.length, 'candidate')} · ${fmtSize(Math.max(0, vc.total - held))} on disk` +
    (vc.sel.size ? ` · ${vc.sel.size} selected` : '') +
    ' — nothing here expires; only you delete it.';
  // §17.4 — the way out, AT THE TOP, and now it says WHICH fifty you are looking at rather than
  // only that there are more. "showing 51–100 of 340" answers where you are; "showing the newest
  // 50 of 340" answered neither once a Next button existed.
  const p = vcPages(),
    moreTop = $('vcCandMoreTop');
  if (moreTop) {
    const worthSaying = p.all ? list.length > VC_PAGE : p.pages > 1;
    moreTop.style.display = worthSaying ? '' : 'none';
    if (worthSaying) {
      moreTop.innerHTML =
        (p.all ? `showing all ${list.length} ` : `showing ${p.from + 1}–${p.to} of ${list.length} `) +
        `<button class="xs" id="vcShowAllTop">${p.all ? `Show ${VC_PAGE} per page` : 'Show all'}</button>`;
      /** @type {VEl} */ ($('vcShowAllTop')).onclick = () => {
        vc.show = p.all ? VC_PAGE : 1e9;
        vc.page = 0;
        renderCandidates();
      };
    }
  }
  /** @type {HTMLInputElement} */ ($('vcSelAll')).checked = list.length > 0 && vc.sel.size === list.length;
  /** @type {HTMLButtonElement} */ ($('vcDelSel')).disabled = !vc.sel.size;
  /** @type {VEl} */ ($('vcDelSel')).textContent = vc.sel.size ? `✕ Delete selected (${vc.sel.size})` : '✕ Delete selected';
  // ↩ Undelete last: disabled with an empty bin, exactly like its neighbor, and carrying the same
  // count — the pair is one gesture and its undo, so they should read as a pair.
  const undel = /** @type {HTMLButtonElement} */ ($('vcUndel')),
    n = vcBin.tokens.length;
  if (undel) {
    undel.disabled = !n;
    undel.textContent = n > 1 ? `↩ Undelete last (${n})` : '↩ Undelete last';
  }
}
// One row. Extracted from renderCandidates because loadCandidates also builds rows on their own,
// to prepend new ones without repainting the list — see the incremental path there.
/** @param {import('./design.js').VcCandidate} c */
export function vcRowHTML(c) {
  const bits = [fmtDate(c.created)];
  if (c.duration_s != null) bits.push((+c.duration_s).toFixed(1) + 's');
  bits.push(fmtSize(c.size));
  // 📌 The seed is ON THE ROW, not hidden in the sidecar (§18.4): "a kept row must carry its
  // seed forward, or 'that one, but again' is unanswerable."
  if (c.seed != null) bits.push('seed ' + c.seed);
  // 🔴 flex:0 is a trap here — it means basis 0%, so the box collapses to its MIN-CONTENT width
  // and the text inside wraps one word per line ("Save / as / voice"). It only looks harmless
  // elsewhere in this file because those buttons are single words. The boxes that size to their
  // own content are therefore flex:0 0 auto (basis auto = size to content).
  // ⚠️ The metadata box is the ONE EXCEPTION and is deliberately NOT auto: .vcmeta pins it to a
  // fixed basis so the players line up down the column. See that rule in the stylesheet for why
  // it needs two selectors to survive `.row>div`.
  return `<div class="panel" data-vccard="${esc(c.token)}" style="margin-top:8px;padding:8px 10px">
      <div class="row" style="align-items:center;gap:10px;margin:0">
        <input type="checkbox" data-vcsel="${esc(c.token)}"${vc.sel.has(c.token) ? ' checked' : ''} style="flex:0 0 auto;margin:0" title="Select this one for the mass-delete">
        <div class="vcmeta" title="${esc(bits.join(' · '))}"><span class="muted small">${esc(bits.join(' · '))}</span></div>
        <audio controls preload="none" data-vcaudio="${esc(c.token)}" src="${esc(c.url)}" style="flex:1 1 220px;min-width:0"></audio>
        <div style="flex:0 0 auto;display:flex;gap:6px">
          <button class="ok" data-vcsave="${esc(c.token)}" title="Keep this voice — you'll name it next">✓ Save</button>
          <button class="danger" data-vcdel="${esc(c.token)}" title="Delete this clip. It goes straight into the one-slot recycle bin — ↩ Undelete last brings it back, until the next delete takes its place and this one comes off disk.">✕ Delete</button>
        </div>
      </div></div>`;
}
// Each candidate row is INDEPENDENT (§14.3): no radio, no "choose". Any of them can be saved,
// each under its own name — sometimes several draws are good, and there is real variation
// between them — so "the rejected candidate" isn't a concept here.
//
// 🔴 WHAT §18.5 CHANGED. The row used to carry ✕ Discard, which hid it and deleted nothing,
// because a TTL was going to sweep the clip anyway. There is no TTL now, so hiding a row would
// leave the bytes on disk forever with no way to ever see them again — a leak with a friendly
// button on it. Discard is therefore a real Delete, and the checkbox beside it is what makes a
// hundred of them survivable: select, then one mass-delete.
export function renderCandidates() {
  const box = /** @type {VEl} */ ($('vcCandidates')),
    head = /** @type {VEl} */ ($('vcCandHead')),
    more = /** @type {VEl} */ ($('vcCandMore'));
  // 🔴 THE LIST AS PRESENTED, everywhere below — a binned row is a row the user has deleted, and
  // this function is what "deleted" looks like. ⚠️ The header stays visible while the bin holds
  // something even though there are no rows: hiding it would take ↩ Undelete last off screen at
  // the exact moment it is the only control that matters.
  const list = vcLive();
  head.style.display = list.length || vcBin.tokens.length ? '' : 'none';
  if (!list.length) {
    box.innerHTML = '';
    more.style.display = 'none';
    vcRenderCandHead();
    if (!vcBin.tokens.length) /** @type {VEl} */ ($('vcCandTotals')).textContent = '';
    return;
  }
  // §18.4 — "a few hundred would be unwieldy". Newest first, and only the newest `vc.show` are
  // in the DOM; the rest are one click away. The cap is on RENDERING, never on the list itself:
  // "showing 100 of 340" is honest, and a silently truncated list would read as "that is all
  // there is" about a store that only the user empties.
  const p = vcPages();
  const shown = list.slice(p.from, p.to);
  box.innerHTML =
    shown.map(vcRowHTML).join('') +
    `<div style="margin-top:8px"><button id="vcRegen">↻ Generate again</button> <span class="muted small">— fresh random draws, ADDED to the list (design is hit-and-miss; keep going till one's right)</span></div>`;
  /** @type {VEl} */ ($('vcRegen')).onclick = () => /** @type {VEl} */ ($('vcGenBtn')).click();
  vcRenderCandHead();
  // ── the footer: ‹ Previous · Page n of m · Next › · Show all ──────────────
  //
  // 🔴 IT SAYS WHERE YOU ARE, NOT JUST THAT THERE IS MORE. The old footer read "Showing the newest
  // 50 of 340" from every page, which is true and useless once there is a Next button — you cannot
  // tell page 2 from page 6, and after a delete you cannot tell whether the list moved under you.
  //
  // ⚠️ Prev/Next are DISABLED at the ends rather than hidden. A control that vanishes takes the row
  // of buttons with it and the one you want moves under the cursor between clicks, which on a
  // 7-page list is a misclick on ✕ Delete waiting to happen.
  // 📌 Back to the TOP of the list on a page change. The buttons are at the bottom, so without this
  // a click on Next leaves you looking at the bottom of the new page; landing at the top makes the
  // page transition clear.
  /** @param {number} n */
  const go = n => {
    vc.page = n;
    renderCandidates();
    const h = $('vcCandHead');
    if (h && h.scrollIntoView) h.scrollIntoView({ block: 'start', behavior: 'instant' });
  };
  if (p.all && list.length > VC_PAGE) {
    more.style.display = '';
    more.innerHTML = `Showing all ${list.length}. <button class="xs" id="vcPaged">Show ${VC_PAGE} per page</button>`;
    /** @type {VEl} */ ($('vcPaged')).onclick = () => {
      vc.show = VC_PAGE;
      vc.page = 0;
      renderCandidates();
    };
  } else if (p.pages > 1) {
    more.style.display = '';
    more.innerHTML =
      `<button class="xs" id="vcPrev"${p.page ? '' : ' disabled'}>‹ Previous</button> ` +
      `<span style="margin:0 8px">Page ${p.page + 1} of ${p.pages} — showing ${p.from + 1}–${p.to} of ${list.length}</span>` +
      `<button class="xs" id="vcNext"${p.page < p.pages - 1 ? '' : ' disabled'}>Next ›</button>` +
      ` <span style="margin:0 6px">·</span><button class="xs" id="vcShowAll">Show all</button>`;
    /** @type {VEl} */ ($('vcPrev')).onclick = () => go(p.page - 1);
    /** @type {VEl} */ ($('vcNext')).onclick = () => go(p.page + 1);
    /** @type {VEl} */ ($('vcShowAll')).onclick = () => {
      vc.show = 1e9;
      vc.page = 0;
      renderCandidates();
    };
  } else more.style.display = 'none';
  vcWirePlayback(box);
}
// §18.4's auto-advance behavior was removed. With a batch landing rows every 30–60 s, "the next clip" is whatever
// happens to sit below at the moment one ends, so auto-advance kept starting clips he never
// chose — a fresh round's arrival, or the row beneath when a run finished. Playback is
// click-only now; the only thing a play still does on its own is PAUSE the others.
//
// IDEMPOTENT, and the pause-the-others sweep resolves its targets AT EVENT TIME rather than
// capturing them here. Both are for the incremental path in loadCandidates: new rows are
// prepended to a live list, so a captured node list would miss them, and a second wiring pass
// over the whole box would double every handler.
// §20.1 — WHAT TO DO WHEN THE SELF-HEAL DID NOT HEAL IT.
//
// 🔴 A PLAYER THAT IS PERMANENTLY DEAD MUST SAY SO. Grayed controls read as "not ready yet",
// which is exactly the misreading that delayed diagnosis of §20.1: a disabled control looked the
// same as a row that had not loaded. Once
// the one retry has been spent, silence is the wrong answer — the row has to name its own state.
//
// 📌 AND IT RECORDS *WHY*, WHICH IS THE PART §20.1 STILL DOES NOT KNOW. The root cause was never
// found: the clip is on disk, the route serves it, a reload plays it. Every server-side theory has
// since been eliminated by reading the code (see §20.1's own list), so the next real evidence has
// to come from an actual failure — and that evidence is gone the instant the element is re-loaded.
// `MediaError.code` plus the status of a HEAD probe distinguishes the remaining candidates:
// 4 (SRC_NOT_SUPPORTED) with a 200 means the route answered with something that is not audio;
// 2 (NETWORK) means the body died mid-flight; 3 (DECODE) means the bytes really are bad; and any
// non-200 from the probe means the clip is genuinely not there. None of that costs anything until
// something breaks, and it turns the next occurrence into a diagnosis instead of another report.
/**
 * @param {HTMLAudioElement} a
 * @param {number} code    `MediaError.code`, or 0 when the element carried no `.error` at all.
 * @param {string} base    The clip URL with any cache-buster query/fragment already stripped.
 */
export function vcClipDead(a, code, base) {
  /** @type {Record<number,string>} */
  const whyByCode = {
    1: 'the load was aborted',
    2: 'the connection failed',
    3: 'the audio could not be decoded',
    4: 'the server did not send playable audio',
  };
  const why = whyByCode[code] || 'the player failed for a reason it did not name';
  const card = a.closest ? a.closest('[data-vccard]') : null;
  /** @param {string} msg */
  const say = msg => {
    if (!card) return;
    let n = /** @type {HTMLElement|null} */ (card.querySelector('[data-vcdead]'));
    if (!n) {
      n = document.createElement('div');
      n.setAttribute('data-vcdead', '1');
      n.className = 'small wbbad';
      n.style.marginTop = '6px';
      card.appendChild(n);
    }
    n.textContent = msg;
  };
  say('⛔ This clip would not play — ' + why + '. Checking whether the server still has it…');
  // HEAD, not GET: the question is "does this route still answer for this token", and a GET would
  // pull the whole clip down a second time to answer it. Werkzeug answers HEAD for any GET route.
  fetch(base, { method: 'HEAD' })
    .then(r => {
      console.warn('[vocalis §20.1] clip would not play', {
        token: a.dataset.vcaudio,
        mediaError: code,
        probe: r.status,
        src: base,
      });
      say(
        r.ok
          ? '⛔ This clip would not play — ' +
              why +
              ' — but the server still has it (HTTP ' +
              r.status +
              '). Reload the page and it should play.'
          : '⛔ This clip is not there any more — the server answered HTTP ' + r.status + '. Deleting this row is safe.',
      );
    })
    .catch(err => {
      console.warn('[vocalis §20.1] clip would not play, and the probe failed too', {
        token: a.dataset.vcaudio,
        mediaError: code,
        probeError: String(err),
        src: base,
      });
      say('⛔ This clip would not play — ' + why + ' — and the server could not be reached at all.');
    });
}
/** @param {VEl} box */
export function vcWirePlayback(box) {
  // Cast the whole callback, not just `box`: `querySelectorAll` on a bare tag-less selector
  // returns `Element`, whose permissive widening (dom-permissive.d.ts) does not carry `.error`
  // (MediaError) — genuinely audio-only, and the one thing `error` below reads off it.
  /** @type {NodeListOf<HTMLAudioElement>} */ (box.querySelectorAll('audio[data-vcaudio]')).forEach(a => {
    if (a.dataset.wired) return;
    a.dataset.wired = '1';
    const siblings = () => [.../** @type {VEl} */ ($('vcCandidates')).querySelectorAll('audio[data-vcaudio]')];
    a.addEventListener('play', () => {
      vc.playing = /** @type {string} */ (a.dataset.vcaudio);
      siblings().forEach(o => {
        if (o !== a && !(/** @type {HTMLAudioElement} */ (o).paused)) /** @type {HTMLAudioElement} */ (o).pause();
      });
    }); // one at a time, not a chorus
    a.addEventListener('ended', () => {
      vc.playing = '';
    });
    a.addEventListener('pause', () => {
      if (vc.playing === a.dataset.vcaudio) vc.playing = '';
    });
    // 🔴 §20.1 — AN <audio> THAT FAILS ITS LOAD NEVER ASKS AGAIN, AND THAT IS THE WHOLE BUG.
    // The clip was on disk and the route served it the whole time; only the element was
    // broken. It attempted a load at the instant the candidate appeared, got something it could
    // not use, and latched its error state — and because `src` never changes afterward, nothing
    // ever asks a second time. The row then sits dead for the life of the page over bytes that are
    // perfectly readable, which is why a reload "fixed" it.
    //
    // ⚠️ ALWAYS THE NEWEST ROW, never the others: every other row is built long after its clip was
    // written, while this one is built the moment the job reports done — the one moment the file
    // can still be mid-flush. Rather than chase that timing on the server, the element recovers by
    // itself; even with perfect ordering, one slow flush on a busy box would put a dead player in
    // front of him again. ONCE, with a cache-buster, because a retry loop on a genuinely missing
    // clip would hammer the route forever.
    a.addEventListener('error', () => {
      // Read the code BEFORE anything re-loads the element — `a.load()` clears it, so a diagnosis
      // taken after the retry is a diagnosis of the retry and not of the failure being chased.
      const code = (a.error && a.error.code) || 0;
      // Strip the query as well as the fragment. On the SECOND error the src is the retry URL,
      // `…?retry=1754…`, and both the probe and the message below want the real clip URL — a
      // diagnostic that reports a cache-buster back at you is a diagnostic nobody can act on.
      // The candidate route never carries a legitimate query of its own, so this cannot eat one.
      const base = (a.getAttribute('src') || '').split('#')[0].split('?')[0];
      if (a.dataset.retried) {
        vcClipDead(a, code, base);
        return;
      }
      a.dataset.retried = '1';
      if (!base) return;
      setTimeout(() => {
        a.setAttribute('src', base + '?retry=' + Date.now());
        a.load();
      }, 600);
    });
  });
}
// Is a clip playing right now? Read from the DOM rather than from `vc.playing`, because the
// browser's own controls can start and stop one without going through anything we wrote.
export function vcAnyPlaying() {
  return [.../** @type {VEl} */ ($('vcCandidates')).querySelectorAll('audio[data-vcaudio]')].some(
    a => !(/** @type {HTMLAudioElement} */ (a).paused),
  );
}
// Ask for the voice's name. Returns the trimmed name, or null if canceled. There is NO
// default (§14.2) — an empty box is refused in place, because a name the user didn't choose
// tells them nothing about who this is when they meet it in a picker weeks later.
/** @param {string} initial @param {string} errorMsg @returns {Promise<string|null>} */
export function promptVoiceName(initial, errorMsg) {
  return promptForName({
    title: 'Name this voice',
    blurb: 'This is how it appears everywhere you pick a voice.',
    placeholder: 'e.g. Sarah — warm narrator',
    initial: initial,
    error: errorMsg,
    required: 'Give the voice a name.',
    okLabel: 'Save voice',
  });
}
// Delete for real, now. ONE endpoint for every path that removes a clip, because "delete this one"
// is a list of length one — a second endpoint here is how one of them ends up with a guard the
// other never gets.
//
// ↩ SINCE 7.3-m4e THE ✕ GESTURES DO NOT COME HERE DIRECTLY. They go through `vcBinDelete`, which
// defers and calls this for the PREVIOUS deletion. The remaining direct caller is the save path
// (see there for why saving must not be deferrable) and the beforeunload commit at the bottom.
// The `ask` arm is kept because it is the shape a direct mass-delete would need if one ever
// returns; today `vcBinDelete` owns the confirmation, worded for the deferral.
/** @param {string[]} tokens @param {boolean} ask */
export async function vcDelete(tokens, ask) {
  tokens = tokens.filter(Boolean);
  if (!tokens.length) return;
  if (ask) {
    const bytes = vc.cands.filter(c => tokens.includes(c.token)).reduce((n, c) => n + (c.size || 0), 0);
    const go = await modal(
      'Delete candidates',
      `Delete ${vcN(tokens.length, 'candidate')} (${fmtSize(bytes)})? The clips go from disk and do not come back.`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Delete', class: 'danger', value: 1 },
      ],
    );
    if (!go) return;
  }
  // 📌 IT REPORTS WHETHER THE CLIP ACTUALLY WENT. The ✕ button and the mass-delete both ignore
  // this — they have the reloaded list in front of them, which is a better answer than a boolean.
  // The SAVE path cannot: it is about to print a sentence describing what happened to the row,
  // and "its clip is deleted" has to be false when it is not.
  let gone = true;
  try {
    await jpost('/voices/design/delete', { tokens });
  } catch (e) {
    gone = false;
    await modal('Delete failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
  tokens.forEach(t => vc.sel.delete(t));
  await loadCandidates(); // the server is the truth, including about failures
  if (!vc.cands.length) /** @type {VEl} */ ($('vcStatus')).textContent = '';
  return gone;
}
/** @type {VEl} */ ($('vcSelAll')).onclick = () => {
  // Select-all means ALL of them, not the rendered ones — a checkbox above a list saying
  // "showing the newest 100 of 340" that silently meant 100 would be the worst kind of lie on
  // a control whose next click is a delete.
  // ↩ …but never a binned one. Those are rows he has already deleted; sweeping them back into the
  // selection would put them in the NEXT gesture, which is the gesture that commits them.
  const live = vcLive();
  if (vc.sel.size === live.length) vc.sel.clear();
  else live.forEach(c => vc.sel.add(c.token));
  renderCandidates();
};
/** @type {VEl} */ ($('vcDelSel')).onclick = () => vcBinDelete([...vc.sel], true);
/** @type {VEl} */ ($('vcUndel')).onclick = () => vcUndelete();
/** @type {VEl} */ ($('vcCandidates')).addEventListener('change', e => {
  const tok = /** @type {HTMLInputElement} */ (e.target).dataset && /** @type {HTMLInputElement} */ (e.target).dataset.vcsel;
  if (!tok) return;
  if (/** @type {HTMLInputElement} */ (e.target).checked) vc.sel.add(tok);
  else vc.sel.delete(tok);
  // Repaint the HEADER ONLY. A full renderCandidates() here would rebuild every <audio> element
  // and stop the currently auditioned clip while a row is ticked.
  vcRenderCandHead();
});
/** @type {VEl} */ ($('vcCandidates')).addEventListener('click', async e => {
  const drop = /** @type {HTMLElement} */ (e.target).dataset.vcdel;
  // ↩ The row's ✕ still does not confirm, and now it has less need to: the click is undoable until
  // the next one. §18.4 wants one keypress per clip in the triage flow, not two clicks and a dialog.
  if (drop) {
    vcBinDelete([drop], false);
    return;
  }
  const tok = /** @type {HTMLElement} */ (e.target).dataset.vcsave;
  if (!tok) return;
  const btn = /** @type {HTMLButtonElement} */ (e.target);
  let name = /** @type {string|null} */ (''),
    err = '';
  for (;;) {
    name = await promptVoiceName(/** @type {string} */ (name), err);
    if (name === null) return; // canceled — the row stays
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const j = await jpost('/voices/design/save', { token: tok, name });
      // 🔴 THE SAVED ROW LEAVES, AND IT LEAVES BY BEING DELETED. The Voices list is the panel
      // below this one, so a saved
      // candidate is visibly still on the page, one card down, and a copy of it sitting at the
      // top of the queue is just the row he has finished with in the way of the ones he has not.
      //
      // ⚠️ THIS REVERSES 7.0-m7's REVERSAL OF §14.3, AND IT KEEPS §18.5's ACTUAL RULE. The
      // objection that made the row stay was that dropping it would HIDE a clip nothing on the
      // box would ever reclaim — the leak the old ✕ Discard was, wearing a success dialog. That
      // objection is about hiding, not about leaving: this deletes the clip, so there is no
      // orphan. §18.5 says nothing expires on its own; pressing Save is an explicit deletion.
      //
      // ↩ AND IT IS `vcDelete`, NOT `vcBinDelete` — the one place the two still differ. Saving
      // deletes on purpose and the bytes now live inside a real voice, so there is nothing to
      // recover and offering to would be a confusing state rather than a safety net. It also has
      // to be immediate: the sentence below reports whether the clip actually went, and a deferred
      // delete has no answer to give it.
      //
      // 📌 The cost, stated because it was a real feature: a candidate can no longer be saved
      // twice under two names. Save the one you want, then ↻ Generate again — which is the loop
      // the panel is built around anyway.
      //
      // ⚠️ THE ROUTE IS UNCHANGED AND STAYS A PURE COPY. `/voices/design/save` does not consume
      // its candidate — `from_scratch` (m6) depends on that, and a `consume` flag would put a
      // second meaning on a route two callers already agree about. The consuming is the UI's,
      // because it is the UI's rule.
      //
      // `vcDelete` before the dialog so the list is already right underneath it, and because a
      // delete that fails gets to say so on its own rather than behind a success message. It
      // reloads the candidates itself, so the totals follow the deletion.
      const gone = await vcDelete([tok], false);
      await modal(
        'Voice created',
        `<b>${esc(j.label || j.name)}</b> saved (peak ${j.peak_dbfs != null ? (+j.peak_dbfs).toFixed(1) + ' dBFS' : 'normalized'}). It's in your voices and every render picker now.<div class="small muted" style="margin-top:8px">${
          gone
            ? 'The candidate has left the list — its clip is deleted, the same as pressing ✕ on it. The voice itself is in the panel below.'
            : 'The voice was saved, but the candidate clip could not be deleted, so its row is still in the list. Press ✕ on it when you get a chance.'
        }</div>`,
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
      voiceListLoad();
      loadVoices();
      return;
    } catch (e2) {
      btn.disabled = false;
      btn.textContent = '✓ Save';
      // 🔴 A taken name is REJECTED, never overwritten — so re-ask rather than offering a
      // destructive way out. The typed name is kept so it can be edited, not retyped.
      if (/** @type {ErrLike} */ (e2).status === 409) {
        err =
          /** @type {string|undefined} */ (/** @type {ErrLike} */ (e2).body && /** @type {ErrLike} */ (e2).body.message) ||
          'A voice already has that name.';
        continue;
      }
      await modal('Save failed', esc(/** @type {ErrLike} */ (e2).message), [{ label: 'OK', class: 'primary', value: 1 }]);
      return;
    }
  }
});
// ↩ ON THE WAY OUT, COMMIT THE BIN — closing the tab commits the pending deletion.
//
// 📌 `keepalive`, because the page is going: an ordinary fetch is canceled when the document is
// torn down, which is precisely the moment this runs. `sendBeacon` would be the other way, but it
// cannot set Content-Type: application/json without a Blob and the route wants JSON.
//
// ⚠️ IT IS BEST-EFFORT, AND THE FAILURE DIRECTION IS THE SAFE ONE. If it does not land, the clip is
// still on disk and its row is back on the next visit — a candidate that outlives a delete, in a
// panel whose stated contract is "nothing here expires; only you delete it". The other direction —
// guaranteeing the delete by sending it earlier — is what the whole feature exists to stop.
addEventListener('beforeunload', () => {
  if (!vcBin.tokens.length) return;
  try {
    fetch('/voices/design/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens: vcBin.tokens }),
      keepalive: true,
    });
  } catch (e) {
    /* the page is leaving; there is nobody left to tell */
  }
});
