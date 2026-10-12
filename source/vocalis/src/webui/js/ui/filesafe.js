// ui/filesafe.js — the spacebar must not open a file dialog (7.5.25).
//
// Focused native file inputs open the picker on Space as well as Enter. Suppress Space so it keeps
// its page-scroll meaning while leaving Enter available as the keyboard route to the picker.
//
// 🔴 THE MECHANISM. A native `<input type="file">` opens its picker on Enter OR SPACE while
// focused. Fourteen of Vocalis's nineteen file inputs are `display:none` behind a
// `<label class="filebtn">`, so they cannot hold focus and cannot do this. Five are bare and
// visible — `bookFile`, `vAddFile`, `vtImpPth`, `vtImpIdx`, `blkFiles` — and every one of them is
// one Tab away from the scroll key. Focus lands there (a click near the control, a Tab through the
// panel), Space would open a file dialog instead of scrolling the page.
//
// Confirmed rather than reasoned about: driving a headless Chrome with
// `Page.setInterceptFileChooserDialog` and dispatching one Space keydown to a focused `#vAddFile`
// raises `Page.fileChooserOpened` (`mode: selectSingle`); the same key on the text box beside it
// raises nothing.
//
// WHY SPACE AND NOT ENTER. Enter stays live as a keyboard route to a file input. Space is the
// page-scroll key, so on a file input its
// native meaning is in permanent conflict with what the user is asking for — and a keyboard user
// who wants the picker still has Enter. That asymmetry is the whole fix.
//
// ⚠️ AND "ENTER DOES NOT OPEN ONE ANYWAY" IS A HARNESS ARTIFACT — it was measured, believed, and
// was wrong. CDP's `Input.dispatchKeyEvent` delivers Enter's ACTIVATION only under `type:
// 'keyDown'`; under `rawKeyDown` the keydown arrives and the picker does not open. Space opens it
// under both, so a probe using `rawKeyDown` for both keys reports "Space opens one, Enter does
// not" — which reads as "Chrome has no Enter route, so blocking Space costs nothing", exactly the
// wrong premise for deciding what this guard may swallow. Settled on a bare `data:` page holding
// one `<input type=file>` and no script: under `keyDown`, ENTER OPENS THE PICKER TOO.
//
// ⚠️ CAPTURE PHASE, and `document` rather than each input. Capture, because a feature's own
// keydown handler must not be able to swallow the event before this runs — `vAddFile` already has
// one. `document`, because the hazard belongs to the CLASS: this holds for the five bare inputs
// today and for the next one somebody adds without knowing any of the above, which is the failure
// this file exists to make impossible rather than to fix five times.
document.addEventListener(
  'keydown',
  e => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    const el = /** @type {HTMLInputElement|null} */ (e.target);
    if (el && el.tagName === 'INPUT' && el.type === 'file') e.preventDefault();
  },
  true,
);
