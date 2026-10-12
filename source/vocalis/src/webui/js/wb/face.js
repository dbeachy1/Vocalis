/** Avatar rendering and focus-crop helpers shared by the editor and SillyTavern character views.
 */
import { esc } from '../util/dom.js';

/** Minimum document fields read by `wbFaceHtml`.

 * @typedef {object} WbFaceDoc
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [avatar] - whether a picture EXISTS, never a path. Only ever tested for
 *   falsiness (`!doc.avatar`) here.
 *  *
 *   ⚠️ THE `string` THAT WAS IN THIS UNION CAME FROM A MISREADING, AND IT IS WORTH RECORDING
 *   BECAUSE IT LOOKED RIGHT. `st/chars.js` has two different fields called `avatar` — its
 *   `StCardDoc.avatar` (a `/wbedit/documents` row, the same payload as here) and its
 *   `StCharEntry.avatar` (SillyTavern's own filename, a real string, used as the `byRef` key).
 *   Widening this slot to admit "the string one" made the two compatible by making both wrong:
 *   `wbedit.py:545` sends `store.has_asset(...)`, which is `-> bool` at
 *   `wbedit/store/documents.py:1186`. Both typedefs now say `boolean`.
 * @property {{x:number,y:number,w:number}|null} [focus]
 * @property {string} [avatar_at] - the picture's `(size, mtime)` in hex, `""` when there is none.
 * @property {string} [thumb_at] - the THUMBNAIL's cache key: `(size, mtime)` AND the focus rect,
 *   the same string its ETag is built from. `""` when there is no picture. See `wbFaceHtml`.
 */

// 🔴 THE CIRCLE IS A REGION OF THE CARD PNG, NOT A SECOND IMAGE. `doc.focus` is `{x,y,w}` as
// FRACTIONS — x/y the square's top-left over the width/height, w its side over the WIDTH (so it
// is square whatever the source aspect). Absent means "the largest centered square", which is
// most cards: neither card on the fork's own test login carries a rect.
//
// The math runs on `load` rather than at render, because it needs `naturalWidth`/`naturalHeight`
// and nothing else knows them — the server sends the file, not its dimensions. Doing it from the
// natural size also means no aspect ratio is ever assumed: a `background-position` percentage or
// an `object-position` would need one, and would be quietly wrong on a non-square card.
/** @param {HTMLImageElement} img */
export function wbFitFace(img) {
  // `parentNode` is a `ParentNode`, which has no `clientWidth`/`offsetWidth` — this element is
  // always the `.wbface`/`.wbpick` wrapper `wbFaceHtml` built, an `HTMLElement` at runtime.
  const box = /** @type {HTMLElement|null} */ (img.parentNode),
    W = img.naturalWidth,
    H = img.naturalHeight;
  if (!W || !H || !box) return;
  const size = box.clientWidth || box.offsetWidth;
  let f = null;
  try {
    f = JSON.parse(box.dataset.focus || 'null');
  } catch (e) {
    f = null;
  }
  let side, sx, sy;
  if (f && f.w > 0) {
    side = f.w * W;
    sx = (f.x || 0) * W;
    sy = (f.y || 0) * H;
  } else {
    side = Math.min(W, H);
    sx = (W - side) / 2;
    sy = (H - side) / 2; // largest centered square
  }
  // Clamp into the image, the way their own resolver does: a rect saved against a since-replaced
  // picture can point outside it, and an unclamped crop shows the background through the circle.
  side = Math.max(1, Math.min(side, W, H));
  sx = Math.max(0, Math.min(sx, W - side));
  sy = Math.max(0, Math.min(sy, H - side));
  const k = size / side;
  img.classList.add('wbfit');
  img.style.width = W * k + 'px';
  img.style.height = H * k + 'px';
  img.style.left = -sx * k + 'px';
  img.style.top = -sy * k + 'px';
}

// A face, or the initial when the document has no picture — a JSON-exported card and every
// worldbook. ⚠️ `doc.avatar` is the server telling us whether one EXISTS; do not infer it from
// the kind, because a card imported as .json has none either.
// `wbopen` + `data-id` so the face is a click target for the row's existing delegated handler —
// a picture in a list is the thing a hand goes to, and the Open button beside it stays.
// ⚠️ m4h / §9a.2 — `opts.clickable === false` for a face OUTSIDE the Library. The delegated
// open-the-editor handler is bound to `wbLib`, so a face in the Character Voices list is not
// reachable by it; leaving `cursor:pointer` on would promise a click that does nothing.
/**
 * @param {WbFaceDoc} doc
 * @param {number} px
 * @param {{clickable?: boolean}} [opts]
 */
export function wbFaceHtml(doc, px, opts) {
  const clickable = !(opts && opts.clickable === false);
  const s = 'width:' + px + 'px;height:' + px + 'px;flex:0 0 auto;cursor:' + (clickable ? 'pointer' : 'default');
  const open = ' class="wbface' + (clickable ? ' wbopen' : '') + '" data-id="' + esc(doc.id) + '" style="' + s + '"';
  if (!doc.avatar) {
    const ch = (doc.name || '?').trim().charAt(0).toUpperCase() || '?';
    return (
      '<div' +
      open +
      ' title="no picture — imported without one">' +
      '<span class="wbinitial" style="font-size:' +
      Math.round(px * 0.44) +
      'px">' +
      esc(ch) +
      '</span></div>'
    );
  }
  // 🔴 EAGER AND HIGH PRIORITY. THE FACES ARE THE POINT OF THIS PAGE — NEVER `loading="lazy"`.
  //
  // `loading="lazy"` tells Chrome to
  // fetch at LOW priority behind the rest of the page, so on a cold load one row's ~700 KB face
  // landed ~10 s after the others — a different row each time, which is what a priority queue
  // looks like from the outside. Lazy-loading is for content BELOW the fold that the user has
  // not asked for; a roster of faces is the content of this page.
  //
  // 📌 The cost this was hiding is real and does not go away: a face is the whole card PNG. The
  // answer to that is a thumbnail (design §9a.8), which needs a decoder. Deprioritizing the full
  // image is not a substitute.
  //
  // ⚠️ THE INITIAL SITS UNDERNEATH THE PICTURE, NOT INSTEAD OF IT. An unloaded circle used to be
  // pixel-identical to the "imported without a picture" state, which is why this got reported as
  // a missing avatar twice. Nothing removes the letter — the <img> simply covers it, and that is
  // what makes the broken-image path free rather than a second code path.
  //
  // 🔴 m4p / §9a.10 — AND THE THUMBNAIL IS WHAT MAKES "EAGER" AFFORDABLE. The paragraph above
  // says the cost this was hiding is real and does not go away; `/thumb` provides the smaller
  // alternative. A 96 px WebP crop is ~3 KB against ~700 KB, so forty of them fetched at high
  // priority is less traffic than one avatar was.
  //
  // 🔴 **NO `data-focus` ON THIS PATH, AND THAT IS THE WHOLE CLIENT-SIDE CHANGE.** The server has
  // already applied the rect at full resolution. `wbFitFace` with no rect falls to its
  // largest-centered-square branch, and the square of a square image is all of it — so the same
  // function handles both without a branch of its own. The rect is stashed in `data-focus-full`
  // for the fallback below.
  //
  // 🔴 9.7.7 — `?v=<thumb_at>` avoids stale cached thumbnails. 9.5.12 established that
  // Chrome repaints an `<img>` whose URL has not changed out of its per-page memory cache without
  // revalidating, and that no response header reaches that — `/thumb` answers `no-cache` and it
  // made no difference. It stamped `/avatar` and stopped there, so uploading a new PNG updated the
  // big picture in the editor and left the circle beside the name showing the old face until a
  // hard reload after the source avatar or crop changes.
  //
  // 🔴 `thumb_at`, NOT `avatar_at`, AND THE DIFFERENCE IS A SECOND BUG. A rect edit changes the
  // crop without touching the file — `set_focus` mints no revision and does not set
  // `avatar_dirty` — so the picture's `(size, mtime)` is identical and only the thumbnail's own
  // key moves. Stamping this URL with `avatar_at` would have fixed ⬆ Upload PNG and left ◎ Set
  // face silently stale, which is precisely what `thumbs.key`'s second input exists to prevent.
  const ch = (doc.name || '?').trim().charAt(0).toUpperCase() || '?';
  const rect = esc(JSON.stringify(doc.focus || null));
  return (
    '<div' +
    open +
    ' data-focus-full="' +
    rect +
    '" data-avatar-at="' +
    esc(doc.avatar_at || '') +
    '">' +
    '<span class="wbinitial" style="font-size:' +
    Math.round(px * 0.44) +
    'px">' +
    esc(ch) +
    '</span>' +
    '<img fetchpriority="high" decoding="async" alt="" src="/wbedit/documents/' +
    encodeURIComponent(doc.id) +
    '/thumb' +
    (doc.thumb_at ? '?v=' + encodeURIComponent(doc.thumb_at) : '') +
    '"></div>'
  );
}

// 🔴 m4p / §9a.10 — A MISS DEGRADES TO THE FULL IMAGE, NEVER TO A BROKEN CIRCLE.
//
// The design says so in as many words, and the reason is that the 700 KB path was correct and was
// the only path until now: an undecodable PNG, a Pillow that failed to import, a card whose crop
// cannot be computed — none of those are reasons to show an empty circle for a character
// whose picture is sitting right there.
//
// So the route answers 415, this fires, and the row goes back to the full image:
// the whole avatar, cropped in the browser from the rect we stashed at render. Only if THAT fails
// too does the `<img>` go, uncovering the initial underneath — which is the pre-existing
// "no picture" rendering and not a new state.
//
// ⚠️ ONE RETRY, MARKED ON THE ELEMENT. Without the flag a 404 on the fallback re-enters here and
// the two `src` assignments ping-pong forever, which is a hang rather than a missing face.
/** @param {HTMLImageElement} img */
export function wbFaceFallback(img) {
  const box = img.parentNode;
  if (!box || img.dataset.fellBack) {
    img.remove();
    return;
  }
  img.dataset.fellBack = '1';
  /** @type {HTMLElement} */ (box).dataset.focus = /** @type {HTMLElement} */ (box).dataset.focusFull || 'null';
  const id = /** @type {HTMLElement} */ (box).dataset.id || '';
  // 9.7.7 — stamped like every other picture URL in this app. A degraded path is still a path:
  // without it, a row that falls back after a replaced picture paints the OLD avatar out of the
  // memory cache, which reads as the fallback being broken rather than as a stale byte.
  const at = /** @type {HTMLElement} */ (box).dataset.avatarAt || '';
  img.src = '/wbedit/documents/' + encodeURIComponent(id) + '/avatar' + (at ? '?v=' + encodeURIComponent(at) : '');
}

//: The picture says what the click will do. Without this it is a `cursor:pointer` with no
//: explanation, which is how the half-built version read: clickable-looking, and inert.
// `VEl`, not `HTMLImageElement`: every call site reaches this element through `wbEl(kind,
// 'wbCard')`, never through a bare DOM query, so `VEl` is what is actually in hand.
/** @param {VEl} img */
export function wbSyncCardZoomTitle(img) {
  img.title = img.classList.contains('wbfull') ? 'Click to shrink it back' : 'Click to see it at its own full size';
}

// 🔴 7.1-m10b — DELEGATED, BECAUSE THE ATTRIBUTES THESE REPLACE WOULD HAVE DIED SILENTLY IN HERE.
// `wbFaceHtml` used to emit `onload="wbFitFace(this)"` and `onerror="wbFaceFallback(this)"`, which
// resolve a function NAME OFF `window` at event time. Module scope makes that lookup find nothing —
// and the failure is invisible where anyone looks: no import error, no red test, just a face that is
// never cropped (the CSS falls back to an `object-fit:cover` square) and a thumbnail miss that
// stops degrading to the full picture. That is the exact "empty circle for a character whose
// picture is sitting right there" the comment above `wbFaceFallback` says must not happen.
//
// 🔴 `true` IS LOAD-BEARING: `load` and `error` DO NOT BUBBLE. A listener in the bubble phase on
// `document` would never see either event; capture is the only phase that reaches an `<img>` from
// above it. Copying one of the delegated `click` handlers elsewhere in the app instead produces a
// listener that is registered, correct-looking, and never called.
/** @param {Event} e */
const wbFaceImg = e => {
  const img = /** @type {Element|null} */ (e.target);
  return img &&
    img.tagName === 'IMG' &&
    img.parentNode &&
    /** @type {Element} */ (img.parentNode).classList &&
    /** @type {Element} */ (img.parentNode).classList.contains('wbface')
    ? /** @type {HTMLImageElement} */ (img)
    : null;
};
document.addEventListener(
  'load',
  e => {
    const i = wbFaceImg(e);
    if (i) wbFitFace(i);
  },
  true,
);
document.addEventListener(
  'error',
  e => {
    const i = wbFaceImg(e);
    if (i) wbFaceFallback(i);
  },
  true,
);

// 🔴 AND THE SWEEP, WHICH IS WHAT MAKES THE MOVE INTO A MODULE SAFE RATHER THAN MERELY LIKELY.
//
// m10b registered those two listeners at PARSE time, so nothing could paint a face before them.
// A module is DEFERRED — it runs after the document is parsed — while `wbLoadLib` is still inline
// and reachable from the boot sequence's tab restore. Measured, the module tree wins that race by
// about five sequential round trips (boot awaits /gpus, /voices, /settings/app, /enhance,
// /render-rate, /books and then the roster itself; the tree needs two). **Winning by five round
// trips is still a race**, and the thing it loses is a face that never gets cropped — silent, and
// exactly the class of bug m10b existed to remove.
//
// So instead of reasoning about the margin: catch up on anything that already finished. `complete`
// is true for a FAILED image too, and `naturalWidth === 0` is what separates the two — so this is
// the same fork the listeners make, applied to events that fired before there was anyone to hear
// them. `wbFitFace` recomputes from the natural size and rewrites the same four styles, so a face
// swept here and then re-fitted later is not double-cropped.
for (const img of /** @type {NodeListOf<HTMLImageElement>} */ (document.querySelectorAll('.wbface > img'))) {
  if (img.complete) (img.naturalWidth ? wbFitFace : wbFaceFallback)(img);
}
