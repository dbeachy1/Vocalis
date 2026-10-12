// voice/autoplay.js — Autoplay for the Create-a-voice candidate queue (7.3-m4).
//
// It is a triage loop, not a jukebox: listen to the top candidate, decide, press ✓ Save or
// ✕ Delete, and the next one starts. **A clip reaching its end plays nothing** — there is
// deliberately no `ended` listener in this file, and that absence is the feature.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THIS MODULE CHANGES NOT ONE LINE OF THE CODE IT DRIVES, AND THAT IS THE DESIGN.
//
// The obvious build calls an `autoplayAdvance()` from `vcDelete` and from the save path. Those
// are two lines of new INLINE JavaScript, and `tests/test_webui_size.py`'s ratchet refuses them:
// `INLINE_SCRIPT_LINES` may only ever go DOWN during 7.3, and its failure message says outright
// that "I need three more lines of inline JS" is the request being denied — it is a module.
//
// So this observes the interaction instead:
//
//   1. a click on ✓ Save, ✕ Delete or ✕ Delete selected ARMS it, remembering the top row's token
//   2. a MutationObserver on #vcCandidates fires when the list repaints
//   3. the first repaint that REMOVES a row spends the arm, whether or not it advances — and it
//      advances only if the top row's token has actually changed
//
// ✅ AND OBSERVING IS BETTER HERE THAN BEING CALLED, not merely cheaper. Row removal is the
// success condition: `vcDelete` returns
// `gone=false` when the delete fails and leaves the row in place, so a hook would have had to
// remember to check that. Watching the DOM makes the trigger and the success the same fact.
//
// ✅ It is right for the mass delete too. Deleting a selection that did not include the top row
// leaves the top row alone, so nothing re-plays — restarting the current clip would be a bug,
// and the token comparison rules it out without a special case.
//
// ⚠️ ARMING IS WHAT KEEPS IT FROM BECOMING A JUKEBOX. #vcCandidates repaints for other reasons —
// ↻ Generate landing a new candidate, Show all, the overnight batch finishing — and every one of
// those changes the top row. Without the arm, each would start playing something, which is
// exactly the behavior this triage flow avoids.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 📌 STATE LIVES IN `UIS`, NOT localStorage. `UIS` is the account-local, server-side (and on an
// encrypted install, encrypted) UI state store declared as a top-level `const` in index.html. A
// module reads it through the scope chain — a top-level `const` in a classic script lives in the
// global LEXICAL environment, which is in a module's scope chain (js/main.js leans on exactly this
// for `vocalis-tab` and `stTab`). So the tick follows the account to another browser and survives a
// restart, which is the same reason the KoboldCpp config pick and `vocalis-vtab` work this way.

// 🔴 THIS MODULE EXPORTS NOTHING, ON PURPOSE, AND IS IMPORTED FOR ITS SIDE EFFECT ALONE —
// the second such module in the tree after js/wb/wire.js, whose header states the reason this
// one borrows: a file that exists to ATTACH listeners must not hand out a way to attach them
// twice. Exporting `wireAutoplay` would let some later caller double every handler here, and a
// doubled MutationObserver would play the top row twice over. The module cache already
// guarantees one evaluation; exporting the entry point is the only way to break that.

import { $ } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13

const KEY = 'vocalis-vc-autoplay';

// The token identifies the CLIP, not the row element — renderCandidates() rebuilds the whole list
// on every repaint, so element identity is worthless here and `data-vccard` is what survives.
const topCard = () => document.querySelector('#vcCandidates [data-vccard]');
const topToken = () => {
  const c = topCard();
  return c ? /** @type {string} */ (/** @type {HTMLElement} */ (c).dataset.vccard) : null;
};

/** @type {string|null} */
let armed = null; // the token that was on top when Save/Delete was clicked
/** @type {MutationObserver|null} */
let observer = null;

function on() {
  return !!($('vcAutoplay') && /** @type {HTMLInputElement} */ ($('vcAutoplay')).checked);
}

// Stop whatever else is going before starting the new one. Normally unnecessary — the old row has
// been removed from the DOM, which stops its <audio> with it — but ticking the box while an
// earlier clip is still playing would otherwise leave two of them going at once.
function playTop() {
  const card = topCard();
  if (!card) return;
  const next = card.querySelector('audio[data-vcaudio]');
  if (!next) return;
  for (const a of document.querySelectorAll('#vcCandidates audio[data-vcaudio]')) {
    if (a !== next && !(/** @type {HTMLAudioElement} */ (a).paused)) {
      /** @type {HTMLAudioElement} */ (a).pause();
    }
  }
  // ⚠️ `.catch`, always. play() returns a promise that REJECTS when the browser blocks autoplay,
  // and an unhandled rejection in the console looks like a bug. Every path here
  // runs inside a user gesture (ticking the box, or clicking Save/Delete), so it should not fire —
  // but "should not" is not a reason to ship an unhandled promise.
  const p = /** @type {HTMLAudioElement} */ (next).play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

// Arm on the gestures that REMOVE a row, and only those. Save is included because saving deletes
// the candidate — `vcDelete` is what index.html calls after `/voices/design/save` returns, so a
// saved row leaves exactly like a deleted one.
/** @param {MouseEvent} e */
function arm(e) {
  if (!on()) return;
  const t = e.target;
  if (!t || !(/** @type {HTMLElement} */ (t).dataset)) return;
  if (/** @type {HTMLElement} */ (t).dataset.vcsave || /** @type {HTMLElement} */ (t).dataset.vcdel) armed = topToken();
}

function wireAutoplay() {
  const box = /** @type {HTMLInputElement} */ ($('vcAutoplay'));
  if (!box) return; // the Create tab is hidden without VoxCPM2 — nothing to wire

  try {
    box.checked = UIS.getItem(KEY) === '1';
  } catch (e) {
    /* no stored preference — off */
  }

  box.addEventListener('change', () => {
    try {
      UIS.setItem(KEY, box.checked ? '1' : '0');
    } catch (e) {
      /* not fatal: the tick still works */
    }
    armed = null; // a fresh tick is not a pending advance
    if (box.checked) playTop(); // "When I check that, it starts playing the top row."
  });

  // Both listeners are passive observers: they never preventDefault and never stop propagation, so
  // the queue's own handlers run exactly as before. This file cannot break the panel by design.
  //
  // 🔴 CAPTURE PHASE, AND IT IS LOAD-BEARING (7.3-m4e). `arm` has to read the top row as it was
  // BEFORE the gesture, and js/voice/candidates.js registers its own click handler on this same
  // element first — so in the bubble phase we would run second. That was harmless only while
  // deleting was asynchronous: the old `vcDelete` awaited the route before repainting, so the list
  // was still intact when a bubble-phase `arm` ran. `vcBinDelete` defers instead, which means it
  // repaints SYNCHRONOUSLY inside that first handler — and a bubble-phase `arm` then recorded the
  // row that had already replaced the deleted one, so the observer saw "the top row is what I
  // armed" and never advanced. Capture runs on an ancestor before the event reaches the target, so
  // this is ordering by construction rather than by luck about who awaits what.
  const list = $('vcCandidates');
  if (list) list.addEventListener('click', arm, true);
  // ⚠️ `arm2` CANNOT use the same trick and does not need to: it is on the button ITSELF, and
  // listeners on the target fire in registration order whatever the capture flag says. It is safe
  // because `vcBinDelete(…, true)` awaits the confirmation dialog before it touches the list, so
  // the list is still intact when this runs. If that mass-delete ever stops confirming, this needs
  // to move to a capture listener on an ancestor.
  const delSel = $('vcDelSel');
  if (delSel) delSel.addEventListener('click', arm2);

  if (list && !observer) {
    // 🔴 ONE GESTURE GETS ONE CHANCE TO ADVANCE, AND THE ARM IS SPENT EITHER WAY (7.3-m4b).
    //
    // This used to `return` without clearing `armed` when the top row had survived — so deleting a
    // NON-top row left the arm set indefinitely, and the next repaint that happened to change the
    // top row fired it. That repaint is a new candidate ARRIVING: ↻ Generate, or the overnight
    // batch landing a round. A clip then starts on its own, minutes after the click that armed it,
    // over whatever was being auditioned — the exact jukebox behavior this feature avoids.
    //
    // 📌 FOUND BY SABOTAGING `arm2`'s WIRING and watching the spec stay green: the mass-delete
    // check was riding an arm left over from an earlier check rather than the one it was about. A
    // leaked arm makes a spec pass for the wrong reason in exactly the same way it makes the page
    // play the wrong clip.
    //
    // ⚠️ SPENT ON A REPAINT THAT REMOVED A ROW, NOT ON ANY MUTATION. §20.1's dead-clip notice is
    // appended INTO a row, and re-writing its text replaces a child node — both are childList
    // mutations inside this subtree. Clearing on those would eat the arm of a delete still in
    // flight (`vcDelete` awaits the route and then awaits `loadCandidates`, and a clip can fail
    // its load inside that window), and the gesture would silently not advance.
    observer = new MutationObserver(records => {
      if (armed === null || !on()) return;
      const tookARowOut = records.some(r =>
        /** @type {HTMLElement[]} */ ([...r.removedNodes]).some(
          n => n.nodeType === 1 && (n.matches('[data-vccard]') || n.querySelector('[data-vccard]')),
        ),
      );
      if (!tookARowOut) return; // not the gesture landing — a notice, or a row arriving
      const was = armed;
      armed = null;
      if (topToken() === was) return; // the top row survived — a non-top row was removed
      playTop();
    });
    observer.observe(list, { childList: true, subtree: true });
  }
}

// ✕ Delete selected lives OUTSIDE #vcCandidates, in the header, so it needs its own arm — and it
// carries no data-vcdel, so `arm` would ignore it.
function arm2() {
  if (on()) armed = topToken();
}

wireAutoplay();
