// ui/reconcile.js — replace a list's rows IN PLACE, never by assigning innerHTML.
//
// 🔴 THE RULE THIS FILE EXISTS TO ENFORCE: never `innerHTML =` a list that contains
// user-touched elements. An `<audio>` element's playhead is user state exactly as much as a
// `<select>` value is, and a repaint that rebuilds the row throws it away mid-note.
//
// This was first needed in ACE-Step and later in the Stems library. A shared reconciler avoids
// duplicating the same playback-preserving update behavior across tabs.
//
// ⚠️ A ROW'S HTML MUST BE STABLE FOR IDENTICAL CONTENT, or the `__sig` comparison below
// never matches and every row is replaced on every pass — which is `innerHTML =` again with
// extra steps. A renderer that stamps a fresh id per call (`'sw' + ++n`) defeats this; see
// `stemwidget.js`, where the id is now derived from the row's key for exactly this reason.

// ⚠️ THIS IS THE THIRD TIME THE SAME MISTAKE HAS SHOWN UP IN THIS TAB — the card dropdown
// reverting the model you picked, the queue rows changing identity under the reader, and now
// this. The shape is always: repaint from server state on a timer, and destroy whatever the USER
// put in the DOM. An <audio> element's playhead is user state exactly as much as a selection is.
//
// So: rows are keyed, and one is replaced ONLY when its rendered HTML actually differs. A
// finished candidate's row never changes, so its player is never touched and playback survives
// as long as the row does.
// ⚠️ A `data-keep` CHILD IS FURNITURE, NOT A ROW. The library's "Download as" picker lives INSIDE
// this grid — it is the only way its left edge can line up with the Download button, which sits in
// the fourth track — so the reconcile has to leave it alone. Both paths would otherwise destroy
// it: the sweep below removes anything without the key, and the empty state assigns innerHTML.
/**
 * @template {{id: string}} T
 * @param {VEl} host
 * @param {T[]} items
 * @param {string} key - the `data-*` suffix (`dataset[key]`) items are keyed on; almost always
 *   redundant with `it.id` (see the cast below) — kept as a fallback for a row shape that ever
 *   keys on something else.
 * @param {(item: T) => string} render
 * @param {string} emptyHtml
 */
export function reconcile(host, items, key, render, emptyHtml) {
  const keep = [.../** @type {HTMLCollectionOf<HTMLElement>} */ (host.children)].filter(c => c.dataset && c.dataset.keep !== undefined);
  if (!items.length) {
    host.innerHTML = emptyHtml;
    // 🔴 BACKWARD, OR THE FURNITURE COMES BACK IN REVERSE ORDER (9.7.0). Each `insertBefore
    // (k, host.firstChild)` puts `k` at the FRONT, so walking `keep` forwards lands the last
    // child first and the list arrives inverted. It was invisible for as long as every host had
    // exactly one `data-keep` child; the ACE library now has two — the heading row and the
    // filter/sort/bulk bar under it — and on an empty library they swapped places. A list is
    // empty exactly when a filter has just excluded everything, i.e. while the user is typing,
    // which is the worst possible moment for the header to rearrange itself.
    for (let i = keep.length - 1; i >= 0; i -= 1) host.insertBefore(keep[i], host.firstChild);
    return;
  }
  // 🔴 THE CAST IS THE `it[key]` FALLBACK, NOT `it.id` — every real T (AceJob, AceLibrarySong)
  // declares `id` as a required string, so `?? it[key]` is dead in practice; the checker cannot
  // see that, and a generic `T` has no index signature to satisfy `it[key]` honestly on its own.
  const wanted = new Map(items.map(it => [String(it.id ?? /** @type {Record<string, unknown>} */ (it)[key]), it]));
  for (const el of [.../** @type {HTMLCollectionOf<HTMLElement>} */ (host.children)]) {
    if (el.dataset && el.dataset.keep !== undefined) continue;
    const k = el.dataset ? el.dataset[key] : null;
    if (!k || !wanted.has(k)) el.remove(); // gone, or the empty-state placeholder
  }
  // 🔴 Rows start AFTER the furniture. With `prev` at null the first insert would land before the
  // header, putting the picker in the middle of the list on the very first paint.
  let prev = keep.length ? keep[keep.length - 1] : null;
  for (const [k, it] of wanted) {
    const html = render(it);
    let el = [.../** @type {HTMLCollectionOf<HTMLElement>} */ (host.children)].find(c => c.dataset && c.dataset[key] === k);
    if (!el || el.__sig !== html) {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const fresh = /** @type {HTMLElement|null} */ (tmp.firstElementChild);
      if (!fresh) continue;
      fresh.__sig = html;
      // 🔴 THE LIVE <audio> MOVES INTO THE NEW ROW RATHER THAN BEING THROWN AWAY WITH THE OLD ONE.
      // Keying the rows stopped the 2 s poll from rebuilding them, but a genuine row change still
      // replaces it. Carry live media across that replacement as well.
      // Carrying the element across fixes that for every such change at once — favorite, rename,
      // anything — rather than one re-render trigger at a time.
      // ⚠️ ONLY WHEN THE SOURCE IS IDENTICAL. Moving a player between two different songs would
      // keep the audio going while the row around it says something else, which is a worse bug
      // than the one being fixed.
      if (el) {
        const live = el.querySelector('audio');
        const blank = fresh.querySelector('audio');
        if (live && blank && live.getAttribute('src') === blank.getAttribute('src')) {
          blank.replaceWith(live);
        }
        host.replaceChild(fresh, el);
      } else host.insertBefore(fresh, prev ? prev.nextSibling : host.firstChild);
      el = fresh;
    }
    // 🔴 8.9.13 — AN EXISTING ROW IS MOVED, NOT LEFT WHERE IT WAS. Until this line, a row whose
    // HTML had not changed was never touched, so `reconcile` honored the display ORDER only for
    // rows it had to create or replace. That was invisible while the order came from the server
    // (a list sorted by date does not reshuffle) and it broke the moment virtual folders made
    // POSITION meaningful: after `⇤ Remove from folder`, the song's markup is identical, so the
    // row went on painting between the folder header and the divider — server unfiled, folder
    // counting (0), screen still showing it filed. Permanently, because nothing would ever change
    // that row's HTML again. Found by driving the un-file in a real browser on the ACE library.
    //
    // ⚠️ A MOVE IS NOT A REBUILD, AND THAT IS WHY THIS IS SAFE FOR A PLAYING <audio>. The HTML
    // spec pauses a media element that has left the document only after awaiting a stable state;
    // a removal and re-insert completed inside ONE synchronous task never reaches one. It is the
    // same guarantee `vsLibPark`/`vsLibMount` in media/swaplib.js is built on, and the ACE
    // library's spec asserts the player survives an un-file.
    const want = prev ? prev.nextSibling : host.firstChild;
    if (el !== want) host.insertBefore(el, want);
    prev = el;
  }
}
