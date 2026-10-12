// The sub-tab key ↔ document kind mapping. 7.1 §5.5 — part of the shared floor `pass.js` needed.
//
// 📌 THIS IS A MOVE, NOT A COPY, AND THE DIFFERENCE IS CHECKABLE. `$`, `esc`, `wbEl` and the four
// `j*` helpers are duplicated because something calls them while the page is still parsing. Nothing
// calls these: every caller is `wbLoadLib`, `wbImport` or `wbLoadInstructions` — all reached either
// from a click handler or from the bootstrap IIFE *after* its first `await` — plus two
// `document.addEventListener('keydown', …)` closures, which register at parse time and run later.
// Registering is not calling (§5.6). So the definition leaves index.html entirely, and the inline
// callers reach it through the `Object.assign(window, …)` shim until they become modules too.

// 🔴 THE SUB-TAB KEY IS NOT THE DOCUMENT KIND, AND CONFLATING THEM EMPTIES THE LIBRARY.
// The tabs are keyed 'cards'/'books' — those strings are persisted as `vocalis-sttab` and are
// what `data-sttab` carries. A document's kind is 'card'/'worldbook', which is what
// `formats.detect` answers and what the store records. Passing the tab key to
// `/wbedit/documents?kind=` filters against a value no document has ever had, so every row is
// dropped and the pane says "nothing imported yet" over a full library. Caught in a real
// browser; every route test passed straight through it, because they call the route with the
// kind the ROUTE expects.
// ⚠️ §8.3's persona is the one member where the tab key and the kind differ only by an 's', which
// makes it the easiest to "simplify" into `kind.replace(/s$/,'')` — that would turn 'books' into
// 'book' and empty the World Books pane. The map stays a map.
export const WB_KIND = { cards: 'card', books: 'worldbook', personas: 'persona' };
/**
 * @param {string} kind - a tab key ('cards'/'books'/'personas'), OR already a document kind
 *   ('card'/'worldbook'/'persona') — some callers pass either, which is why the fallback exists.
 * @returns {string}
 */
export const wbDocKind = kind => WB_KIND[/** @type {keyof typeof WB_KIND} */ (kind)] || kind;
