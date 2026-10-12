// book/library.js — the Library shelf and the Chapters panel under it (7.3-m4l).
//
// Moved verbatim from index.html's `── Library ──` and `── Chapters: the DETAIL half of Library
// (still /output on the wire) ──` banners: 95 lines, five definitions and five wirings. The shelf
// lists every book in output/; the panel below it lists one book's chapters, with a player, a
// download and a ↻ per chapter.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 TWO BANNERS, ONE FILE, BECAUSE THEY CALL EACH OTHER. THIS IS NOT A TIDINESS CHOICE.
//
//   Library  → `clearOutput()` when the book the panel is showing is deleted, and
//              `loadOutput(book)` when a row is clicked
//   Chapters → `loadLibrary()` after ✕ Clear all output, to refresh the shelf the book just left
//
// Split them and each half imports the other. ES modules resolve a cycle like that, so it would
// *work* — and it would be two files whose only neighbor is each other, describing one screen, for
// no gain. §5's file table lists `library.js` and `output.js` separately; the mutual call is the
// measurement that says otherwise, and the banner comment itself already calls Chapters "the DETAIL
// half of Library". One area, one file.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — four names, all plain `function` declarations, all safe on the shim.
//
//   loadLibrary    the shelf's loader. `switchTab`'s library case, and the boot/resume path
//   renderLibrary  🔴 SEE BELOW — `filtWire('libFilter',renderLibrary)`, and it is a PARSE-TIME
//                  BARE VALUE, which is the one shape that kills the page instead of one feature
//   clearOutput    empties the detail half; called from inline code as well as from here
//   loadOutput     fills it for one book
//
// 🔴 THE `filtWire` LINE IS A MINE, AND IT IS THE SAME ONE `satAdd` WAS IN m4a.
//
//     filtWire('libFilter',renderLibrary);          index.html, TOP LEVEL
//
// `renderLibrary` there is a bare identifier evaluated the moment the classic script is PARSED —
// long before any deferred module body has run. Leave that statement inline with `renderLibrary`
// exported from here and it throws `ReferenceError` mid-parse, taking every top-level statement
// after it with it: not "the Library filter stopped working", but most of the page. The wiring line
// has to move into a module (m12 owns `filtWire` itself) or be re-expressed so the name is read at
// call time.
//
// ⚠️ `tests/test_webui_parsetime.py` CANNOT SEE THIS SHAPE. Its `_names_used` matches a name
// followed by `(`, `.` or `[`; a bare identifier passed as an argument matches none of those, and
// the test's own fixture asserts `_names_used("filtWire('scSearch',renderScenes);") == {"filtWire"}`.
// So the guard goes green on exactly the crash it looks like it is for — §11.5 item 1, written down
// after m3 and still true.
//
// 📌 The four `filt*` calls in `renderLibrary` are a different thing and are safe: `filtQ`,
// `filtRows`, `filtCount` and `filtNone` are real imports below, named inside a function body.
// `filtWire` is the only one of the family that runs at parse time, which is why it alone stayed
// inline in m1b.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT REACHES FOR AS AN INLINE GLOBAL — one name, `state`.
//
// The page-wide state object, a top-level `const` in index.html. This file writes three fields of
// it — `state.books`, `state.bookLive` and `state.curBook` — and `state.curBook` is read by inline
// code outside this area, so the object has to be the same object. It is only ever MUTATED, never
// rebound, which is what makes reading it through the scope chain safe (§11.4's `FILT`/`enh` row).
//
// 🔴 DO NOT REDECLARE `state` HERE. Exactly one declaration: a second copy would have this file
// writing `state.curBook` into its own object while the rest of the page reads one that nothing
// updates, and the symptom would be a Chapters panel that acts on the wrong book — the same trap
// §11.4 documents for MODELS/ENCRYPTED.
//
// ⚠️ FIVE TOP-LEVEL WIRINGS CAME WITH THE CODE and none of them is parse-time reachable: they are
// `$('x').onclick=` and `$('x').addEventListener(…)`, which need the ELEMENT to exist, not the
// module. A `type="module"` script runs after the document has parsed, so `libList`, `libRefresh`,
// `outList`, `outConcat` and `outClear` are all there. `$('libRefresh').onclick=loadLibrary` is a
// bare value too — but it is inside this file, where `loadLibrary` is hoisted and in scope.

import { $, esc, scrollUnderStick, stickTop } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.5.27 — remembers which book's chapters were open
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { jdel, jget, jpost } from '../util/http.js';
import { fmtDur, fmtDate, fmtSize } from '../util/fmt.js';
import { filtQ, filtMatch, filtRows, filtNone, filtCount } from '../util/filter.js';
// 8.9 — virtual folders. Scope `books`, keyed on the stable book reference. A display rename
// leaves the key in place, so this scope needs no ref-move hook.
import { folderRows, folderBar, folderGap, folderTag, folderWire, folderWireDrag, folderAddButton, loadFolders } from '../ui/folders.js';
import { modal, confirmDelete, promptForName } from '../ui/modal.js';
/**
 * `/book/jobs` row — `web/books.py`'s `book_jobs()`. A live-job snapshot, independent of
 * `/library`'s sidecar-backed `BookRow` — this is what lets a render be badged "rendering…"
 * before its sidecar exists for `BookRow` to describe at all.
 * @typedef {object} BookJobRow
 * @property {string} id
 * @property {string} docx
 * @property {string} status
 * @property {string} kind
 * @property {number} workers
 * @property {string} gpus
 * @property {string|null} output_dir
 * @property {string} [book] - stable output reference from job registration
 * @property {string} [display_name]
 * @property {string} [voice_label]
 * @property {string} [voice]
 */

/** @type {Map<string, BookJobRow>} */
let liveBookJobs = new Map();

/** Friendly title for human-facing UI; `book` remains the stable API/storage reference. */
/** @param {string} book */
function bookTitle(book) {
  return state.books?.find(b => b.book === book)?.display_name || liveBookJobs.get(book)?.display_name || book;
}

// ── Library ─────────────────────────────────────────────────────────────
export async function loadLibrary() {
  /** @type {VEl} */ ($('libList')).innerHTML = '<span class="muted">Loading…</span>';
  try {
    const [books, jobs] = await Promise.all([
      /** @type {Promise<BookRow[]>} */ (jget('/library')),
      /** @type {Promise<BookJobRow[]>} */ (jget('/book/jobs').catch(() => /** @type {BookJobRow[]} */ ([]))),
    ]);
    // Books being rendered RIGHT NOW: badge them. The placeholder card only covers the
    // brief window before run_job writes the sidecar — from then on the real card shows
    // (and stays, with its n/N progress, even if the render is canceled mid-chapter).
    // 9.5.7 — the order moved to `libOrder`, called from `renderLibrary`, so the drop-down
    // can change it without refetching `/library` and `/book/jobs`. Newest render is still
    // the default; it is no longer the only one.
    await loadFolders(LIB_SCOPE); // 8.9 — names + order; the rows arrive already stamped
    state.books = books;
    liveBookJobs = new Map(
      jobs.filter(j => ['queued', 'running'].includes(j.status) && j.book).map(j => [/** @type {string} */ (j.book), j]),
    );
    state.bookLive = [...liveBookJobs.keys()];
    renderLibrary();
  } catch (e) {
    /** @type {VEl} */ ($('libList')).innerHTML = `<span class="drop">${esc(/** @type {ErrLike} */ (e).message)}</span>`;
  }
}
// Split out of loadLibrary so the filter can re-render from what we already have. Wiring a
// filter to the LOADER would refetch /library and /book/jobs on every keystroke.
const LIB_SCOPE = 'books';

// ── 9.5.7 / the shelf's order ────────────────────────────────────────────────────────────────
//
// The library table supports sorting.
//
// This was a single `books.sort(...)` in `loadLibrary` with `// newest render at the top` beside
// it — the right default and, until now, the only option. 🔴 IT MOVED OUT OF THE LOADER, which is
// the whole change: sorting there meant the order was decided once per fetch, so a control wired
// to it would have had to refetch `/library` and `/book/jobs` on every change. `renderLibrary`
// already exists precisely so the filter box does not do that.
//
// ⚠️ A BOOK WITH NO FINISHED RENDER HAS NO DATE, and there is always at least one — a book
// imported by hand into `output/` has no sidecar, so no `rendered_at`. Compared as 0 it leads the
// oldest-first order it has no business being in, so it sinks instead, the same rule the Clips
// table's `scSortVal` states at length.
const LIB_SORT_KEY = 'vocalis-lib-sort';
const LIB_SORTS = ['new', 'name', 'long'];
let LIB_SORT = 'new';
try {
  const s = UIS.getItem(LIB_SORT_KEY);
  if (s && LIB_SORTS.includes(s)) LIB_SORT = s;
} catch (e) {}
/** @type {HTMLSelectElement} */ ($('libSort')).value = LIB_SORT; // the control shows the order it is using
/** @type {VEl} */ ($('libSort')).addEventListener('change', () => {
  const v = /** @type {HTMLSelectElement} */ ($('libSort')).value;
  LIB_SORT = LIB_SORTS.includes(v) ? v : 'new';
  try {
    UIS.setItem(LIB_SORT_KEY, LIB_SORT);
  } catch (e) {}
  renderLibrary(); // NOT loadLibrary — see above
});

/**
 * The shelf in the chosen order. A copy, because `state.books` is what every other reader here
 * holds and an in-place sort would reorder it under them.
 * @param {BookRow[]} books
 * @returns {BookRow[]}
 */
function libOrder(books) {
  const val = /** @param {BookRow} b */ b =>
    LIB_SORT === 'name' ? b.display_name || b.book || null : LIB_SORT === 'long' ? b.total_duration_s || null : b.rendered_at || null;
  const desc = LIB_SORT !== 'name';
  return [...books].sort((x, y) => {
    const vx = val(x),
      vy = val(y);
    if ((vx === null) !== (vy === null)) return vx === null ? 1 : -1; // undated books sink, both ways
    const c =
      vx === null ? 0 : typeof vx === 'string' || typeof vy === 'string' ? String(vx).localeCompare(String(vy)) : Number(vx) - Number(vy);
    // The title is the tie-break and it never flips with the direction: two books rendered in the
    // same minute must not swap places when the order is changed and changed back.
    return (desc ? -c : c) || String(x.display_name || x.book || '').localeCompare(String(y.display_name || y.book || ''));
  });
}
/** @type {Set<string>} */
const libSel = new Set();

/** Rename a book's friendly title while preserving its stable output reference and open player. */
/** @param {string} book */
async function renameBook(book) {
  const name = await promptForName({
    title: 'Rename book',
    blurb: `Choose the title shown in your Library for <b>${esc(bookTitle(book))}</b>.`,
    okLabel: 'Save',
    initial: bookTitle(book),
  });
  if (name === null) return;
  try {
    const result = /** @type {{book: string, display_name: string}} */ (await jpost(`/book/${encodeURIComponent(book)}/rename`, { name }));
    const row = state.books?.find(b => b.book === result.book);
    if (row) row.display_name = result.display_name;
    const job = liveBookJobs.get(result.book);
    if (job) job.display_name = result.display_name;
    renderLibrary();
    if (state.curBook === result.book) {
      /** @type {VEl} */ ($('outTitle')).textContent = 'Chapters — ' + result.display_name;
    }
  } catch (e) {
    await modal('Rename failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
}

export function renderLibrary() {
  const books = state.books || [],
    live = new Set(state.bookLive || []);
  const known = new Set(books.map(b => b.book));
  // A live job that has no corresponding library row yet is matched by its friendly title.
  const inflight = [...live]
    .filter(n => !known.has(n) && filtMatch(bookTitle(n), filtQ('libFilter')))
    .map(n => {
      const job = liveBookJobs.get(n);
      return `<div class="item bookplaceholder" data-book="${esc(n)}">
    <div class="grow"><div class="t">${esc(bookTitle(n))} <span class="flag">rendering…</span></div>
      <div class="m">render in progress — no chapters finished yet · ${esc(job?.voice_label || 'voice unavailable')}${job?.voice ? ' · ' + esc(job.voice) : ''} · <span class="flag">metadata pending</span></div></div>
    <button class="sm" data-renamebook="${esc(n)}">Rename</button></div>`;
    })
    .join('');
  const shown = libOrder(filtRows('libFilter', books, b => b.display_name || b.book));
  /** @type {VEl} */ ($('libTotals')).textContent = filtCount('libFilter', shown.length, books.length, 'book');
  // 🔴 8.9.13 — DROP THE TICKS THE FILTER HID, not merely the ones whose book is gone. The set is a
  // module `Set` and survives re-renders on purpose (a DOM read would be erased by the next repaint),
  // and that is exactly what made it dangerous: a book the filter box has hidden is still on the
  // shelf, so it kept its tick, and `⇥ Move selected here` filed it alongside the cards actually on
  // screen. Nothing on screen ever named it.
  //
  // ⚠️ THE SET IS `shown` — THE FILTERED ROWS — NOT THE DISPLAYED ONES. A book inside a CLOSED folder
  // is hidden by NAVIGATION, and folders.js draws that line itself: *"Opening a folder is navigation;
  // typing in the box is search, and the two stay orthogonal."* Ticking a book, closing its folder and
  // then pressing ⇤ Remove from folder has to keep working, so a closed folder must not eat the tick.
  const keep = new Set(shown.map(b => b.book));
  for (const n of [...libSel]) if (!keep.has(n)) libSel.delete(n);
  // ⚠️ `inflight` STAYS ABOVE THE FOLDERS and is not fileable. A registered job can have a stable
  // book ref before its first chapter, but the folder cache is keyed from library rows and has no
  // membership for that job. Its card becomes a normal folder-aware row when the library returns it.
  const disp = folderRows(LIB_SCOPE, shown, { query: filtQ('libFilter') });
  /** @type {VEl} */ ($('libList')).innerHTML =
    inflight +
      disp
        .map(e => (e.t === 'folder' ? folderBar(e, { selectable: true }) : e.t === 'gap' ? folderGap() : libRow(e.row, e.in, live)))
        .join('') || (books.length ? filtNone('libFilter') : '<span class="muted">No books yet.</span>');
  libTail(books);
}

/**
 * One book card.
 * @param {BookRow} b
 * @param {string} [inFolder] - the folder's NAME, present only when a filter has flattened the list.
 * @param {Set<string>} [live] - books rendering right now, built once by the caller.
 */
function libRow(b, inFolder, live) {
  const title = b.display_name || b.book;
  const job = liveBookJobs.get(b.book);
  const rendering = !!(live && live.has(b.book));
  const voiceLabel = b.voice_label || job?.voice_label;
  const voice = b.voice || job?.voice;
  const fullAudiobooks = b.full_audiobooks || [];
  return `<div class="item bookcard${b.book === state.curBook ? ' active' : ''}" data-book="${esc(b.book)}" data-vrow="${esc(b.book)}" draggable="true"><label class="vpick" title="Tick this book, then press “⇥ Move selected here” on a folder"><input type="checkbox" class="libchk" value="${esc(b.book)}"${libSel.has(b.book) ? ' checked' : ''}></label>
    <div class="grow"><div class="t">${esc(title)}${rendering ? ' <span class="flag">rendering…</span>' : ''}</div>
      <div class="m">${b.done}/${b.chapters} chapters${voiceLabel ? ' · ' + esc(voiceLabel) : ''}${voice ? ' · ' + esc(voice) : ''}${b.total_duration_s ? ' · ' + fmtDur(b.total_duration_s) : ''}${b.rendered_at ? ' · rendered ' + fmtDate(b.rendered_at) : ''}${rendering && b.has_render_metadata === false ? ' · <span class="flag">metadata pending</span>' : !rendering && (b.has_render_metadata === false || (b.has_render_metadata === undefined && !b.has_sidecar)) ? ' · <span class="flag" title="No render metadata is recorded. Plays and downloads normally.">imported</span>' : ''}</div>
      ${fullAudiobooks.length ? `<div class="book-full-download"><b>Complete audiobooks</b>${fullAudiobooks.map(a => `<div class="full-export"><a class="dlbtn" data-full-download href="/output/${encodeURIComponent(b.book)}/file/${encodeURIComponent(a.file)}?download=1">⬇ Download ${fullAudioFormat(a.file)}</a> <span class="muted">${fullAudioSize(a.size)}</span> <button class="sm danger" data-delete-audiobook="${esc(a.file)}" data-delete-book="${esc(b.book)}" aria-label="Delete ${esc(fullAudioFormat(a.file))} audiobook (${fullAudioSize(a.size)})" title="Delete ${esc(fullAudioFormat(a.file))} audiobook (${fullAudioSize(a.size)})">✕</button></div>`).join('')}</div>` : ''}</div>
    <button class="sm" data-renamebook="${esc(b.book)}">Rename</button>
    <button class="sm danger" data-delbook="${esc(b.book)}" title="Delete this book and all its files">✕</button>
    <button class="sm">Chapters ↓</button>${folderTag(inFolder || '')}</div>`;
}

/** @param {string} filename */
function fullAudioFormat(filename) {
  const ext = String(filename).toLowerCase().split('.').pop() || '';
  return ({ opus: 'Opus', mp3: 'MP3', m4a: 'AAC (Apple)' })[ext] || 'Audio';
}

/** @param {number} size */
function fullAudioSize(size) {
  return size === 0 ? '0 B' : fmtSize(size);
}

/** @param {string} book @param {string} filename */
async function deleteFullAudiobook(book, filename) {
  const codec = fullAudioFormat(filename);
  const row = state.books?.find(b => b.book === book);
  const exportRow = row?.full_audiobooks?.find(a => a.file === filename);
  const size = exportRow ? fullAudioSize(exportRow.size) : 'unknown size';
  const ok = await modal(
    'Delete completed audiobook?',
    `Delete <b>${esc(filename)}</b> (${esc(codec)}, ${esc(size)})?<div class="small" style="margin-top:8px">The book, its chapters, and every other completed audiobook will be kept.</div>`,
    [{ label: 'Cancel', value: 0 }, { label: 'Delete audiobook', class: 'danger', value: 1 }],
  );
  if (!ok) return;
  try {
    await jdel(`/output/${encodeURIComponent(book)}/audiobook/${encodeURIComponent(filename)}`);
    await loadLibrary();
    if (state.curBook === book) await loadOutput(book);
  } catch (err) {
    await modal('Delete failed', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
}

/**
 * The rest of `renderLibrary`, split out only because the row template between them became a
 * function of its own. `books` is passed rather than re-fetched: it is the exact list the render
 * just drew, and re-deriving it here could disagree with what is on screen.
 * @param {any[]} books
 */
function libTail(books) {
  // 7.5.27 — reopen the book that was open. The chapters panel is the whole point of the tab
  // and it used to come back empty after every reload. Restore only if
  // that book is still on the shelf, and only when nothing is selected yet, so a refresh during
  // a render cannot yank the panel off the book he just clicked.
  if (!state.curBook) {
    let want = null;
    try {
      want = UIS.getItem('vocalis-book');
    } catch (e) {}
    if (want && books.some(b => b.book === want)) {
      document
        .querySelectorAll('#libList .bookcard')
        .forEach(x => x.classList.toggle('active', /** @type {HTMLElement} */ (x).dataset.book === want));
      loadOutput(want);
    }
  }
}
/** @type {VEl} */ ($('libList')).addEventListener('click', async e => {
  const rename = /** @type {HTMLElement} */ (e.target).dataset.renamebook;
  if (rename) {
    await renameBook(rename);
    return;
  }
  const del = /** @type {HTMLElement} */ (e.target).dataset.delbook;
  if (del) {
    const title = bookTitle(del);
    const ok = await confirmDelete(
      'Delete book?',
      `This permanently deletes <b>${esc(title)}</b> and <b>all</b> its rendered files — <b>this cannot be undone.</b><br><br>If you're sure, type <b>DELETE</b> below, then click Delete:<br><input id="delType" placeholder="type DELETE" autocomplete="off" style="width:100%;margin-top:8px"></input>`,
    );
    if (!ok) return;
    try {
      await jpost(`/book/clear/${encodeURIComponent(del)}`, { confirm: del });
      if (state.curBook === del) clearOutput(); // the book the panel was showing is gone
      loadLibrary();
    } catch (err) {
      await modal('Delete failed', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    return;
  }
  // The full-book link belongs to the shelf card but is a download action, not a request to
  // open/select that book's chapter panel. Leave the browser's normal link behavior intact.
  if (/** @type {HTMLElement} */ (e.target).closest('a[data-full-download]')) return;
  const deleteAudiobook = /** @type {HTMLElement} */ (e.target).closest('[data-delete-audiobook]');
  if (deleteAudiobook) {
    e.preventDefault();
    e.stopPropagation();
    await deleteFullAudiobook(
      /** @type {HTMLElement} */ (deleteAudiobook).dataset.deleteBook || '',
      /** @type {HTMLElement} */ (deleteAudiobook).dataset.deleteAudiobook || '',
    );
    return;
  }
  // 🔴 8.9 — A TICK IS NOT A CLICK ON THE CARD. The checkbox lives INSIDE the card, so without
  // this the change event fires AND the card handler below opens the book, scrolls the page to
  // the chapters panel and moves the selection — from a gesture that meant "include this one in
  // the next move". The tick is the one control in the card that must not select it.
  if (/** @type {HTMLElement} */ (e.target).closest('.vpick')) return;
  const c = /** @type {HTMLElement} */ (e.target).closest('.bookcard');
  if (c) {
    // Select in place — no tab jump. On a long shelf the panel that just filled in is below
    // the fold, and a click whose only visible effect is off-screen reads as a click that
    // did nothing. So light the row and bring the chapters to the user.
    document.querySelectorAll('#libList .bookcard').forEach(x => x.classList.toggle('active', x === c));
    loadOutput(/** @type {string} */ (/** @type {HTMLElement} */ (c).dataset.book));
    // 🔴 9.0.8 — `nearest` brings it into the VIEWPORT, whose top is behind the sticky header and
    // the pinned tab bar. The case this line was written for is the panel being BELOW the fold,
    // where `nearest` is already right; the case it gets wrong is a card near the top of a
    // scrolled shelf, where the panel is above the fold and `nearest` parks it under the chrome —
    // a click whose only visible effect is hidden, which is the very thing the note above is about.
    const out = /** @type {VEl} */ ($('outPanel'));
    if (out.getBoundingClientRect().top < stickTop()) scrollUnderStick(out);
    else out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});
/** @type {VEl} */ ($('libRefresh')).onclick = loadLibrary;

// ── Chapters: the DETAIL half of Library (still /output on the wire) ─────
// Empty until a book is picked. The per-book actions (concat, clear) are hidden with it —
// they act on state.curBook, so offering them with no book selected would be offering to
// operate on nothing.
export function clearOutput() {
  state.curBook = null;
  /** @type {VEl} */ ($('outTitle')).textContent = 'Chapters';
  /** @type {VEl} */ ($('outActions')).style.display = 'none';
  /** @type {VEl} */ ($('outBlurb')).textContent =
    'Pick a book above to see its chapters — play or download each, ↻ re-render a single chapter, or combine them all into one audiobook file.';
  /** @type {VEl} */ ($('outMeta')).innerHTML = '';
  /** @type {VEl} */ ($('outList')).innerHTML = '<span class="muted">No book selected.</span>';
  document.querySelectorAll('#libList .bookcard').forEach(x => x.classList.remove('active'));
}
/**
 * One row of `/output/<book>`'s `chapters` — `book_state.scan_book()`. A DIFFERENT shape from
 * the central `Chapter` type: that one is `/book/parse`'s pre-render preview, this is a chapter
 * already ON DISK, with both container files and their measured sizes/duration.
 * @typedef {object} OutputChapter
 * @property {number} index
 * @property {string} title
 * @property {string} filename
 * @property {string} status
 * @property {string} [voice]
 * @property {boolean} mismatch
 * @property {number|null} size
 * @property {number|null} duration_s
 * @property {string|null} mp3 - the finished chapter's real filename (.opus or .mp3).
 * @property {string|null} wav - the working master's real filename, if one still survives.
 * @property {number|null} wav_size
 * @property {number|null} mp3_size
 * @property {number|null} duration_claimed - what the SIDECAR claims; the FILE is the truth,
 *   never this — see the header comment on `scan_book` for the 27h19m incident.
 */

/**
 * `/output/<book>` in full — `book_state.scan_book()`.
 * @typedef {object} BookOutput
 * @property {string} book
 * @property {string} [display_name]
 * @property {string} [voice_label]
 * @property {string|null} voice
 * @property {boolean} has_sidecar
 * @property {boolean} [has_render_metadata]
 * @property {boolean} enhance
 * @property {number|null} enhance_nfe
 * @property {number} total_duration_s
 * @property {number|null} total_claimed_s
 * @property {OutputChapter[]} chapters
 * @property {string|null} full_mp3
 * @property {number|null} full_size
 * @property {FullAudiobook[]} full_audiobooks
 * @property {number} wav_bytes
 * @property {number} mp3_bytes
 * @property {number} wav_only
 */

/** @param {string} book */
export async function loadOutput(book) {
  state.curBook = book;
  try {
    UIS.setItem('vocalis-book', book);
  } catch (e) {} // reopened by loadLibrary on the next load
  /** @type {VEl} */ ($('outActions')).style.display = '';
  updateConcatLabel(state.books?.find(row => row.book === book)?.full_audiobooks);
  /** @type {VEl} */ ($('outBlurb')).textContent =
    'Play or download each chapter, ↻ re-render a single one, or combine them all into one audiobook file.';
  /** @type {VEl} */ ($('outTitle')).textContent = 'Chapters — ' + bookTitle(book);
  /** @type {VEl} */ ($('outList')).innerHTML = '<span class="muted">Loading…</span>';
  try {
    const o = /** @type {BookOutput} */ (await jget('/output/' + encodeURIComponent(book)));
    /** @type {VEl} */ ($('outTitle')).textContent = 'Chapters — ' + (bookTitle(book) || o.display_name || book);
    const fullExports = o.full_audiobooks || [];
    /** @type {VEl} */ ($('outMeta')).innerHTML =
      `voice: ${o.voice_label ? esc(o.voice_label) + (o.voice ? ' · ' : '') : ''}${esc(o.voice || '—')} · total ${fmtDur(o.total_duration_s)}${o.enhance ? ` · <span class="badge up" title="Every chapter was enhanced and saved at 256 kbps${o.enhance_nfe ? ` (${o.enhance_nfe} steps)` : ''}. Downloads carry an _enhanced suffix.">Full quality ✨</span>` : ''}${o.has_render_metadata === false || (o.has_render_metadata === undefined && !o.has_sidecar) ? ' · <span class="flag" title="No render metadata is recorded. Plays, downloads, and concatenates normally.">imported (no metadata)</span>' : ''}${fullExports.length ? `<div class="book-full-download"><b>Complete audiobooks</b>${fullExports.map(a => `<div class="full-export"><a class="dl" href="/output/${encodeURIComponent(book)}/file/${encodeURIComponent(a.file)}?download=1">⬇ ${fullAudioFormat(a.file)}</a> <span class="muted">${fullAudioSize(a.size)}</span></div>`).join('')}</div>` : ''}`;
    updateConcatLabel(fullExports);
    // 🔴 SAY WHAT THE BOOK ACTUALLY COSTS, SPLIT BY WHAT CAN BE GOT BACK (7.5.27). Every chapter
    // is stored twice — the lossless WAV and the mp3 the player uses — and the row above reports
    // only the mp3's size, hiding the larger master. The button is offered only when
    // there is something to reclaim, and it names the figure before he presses anything.
    /** @type {VEl} */ ($('outList')).innerHTML =
      o.chapters
        .map(c => {
          const f = c.mp3 ? 'mp3/' + c.mp3 : c.wav || '';
          return `<div class="item"><div class="grow"><div class="t">${esc(c.title)} ${c.mismatch ? '<span class="flag">voice mismatch</span>' : ''}</div>
        <div class="m">${esc(c.filename)}${c.duration_s ? ' · ' + fmtDur(c.duration_s) : ''}${c.duration_claimed && c.duration_s && Math.abs(c.duration_claimed - c.duration_s) > 2 ? ` <span class="flag" title="The render's sidecar recorded ${fmtDur(c.duration_claimed)} for this chapter, but the audio on disk is ${fmtDur(c.duration_s)}. The file is the truth; the sidecar is a note written at render time.">sidecar said ${fmtDur(c.duration_claimed)}</span>` : ''}
          · ${
            c.mp3
              ? `<span class="badge" title="The finished chapter: mp3/${esc(c.mp3)}${c.mp3_size ? ` (${fmtSize(c.mp3_size)})` : ''}. This is what plays and what the audiobook is built from.">${esc((c.mp3.match(/\.([^.]+)$/) || [, '?'])[1].toUpperCase())}</span>`
              : `<span class="flag" title="This chapter has a ${esc(((c.wav || '').match(/\.([^.]+)$/) || [, '?'])[1].toUpperCase())} working file (${c.wav_size ? fmtSize(c.wav_size) : '?'}) that was never turned into a finished chapter. Its audio is fine and it is the only copy — press ✅ Finish chapters above to complete it.">unfinished${c.wav ? ` · ${esc((c.wav.match(/\.([^.]+)$/) || [, '?'])[1].toUpperCase())} ${fmtSize(c.wav_size || 0)}` : ''}</span>`
          }
          ${c.voice ? ' · narrated by ' + esc(String(c.voice).replace(/\.[^.]+$/, '')) : ''}</div></div>
        ${
          f
            ? `<audio controls preload="none" src="/output/${encodeURIComponent(book)}/file/${esc(f)}"></audio>
        <a class="sm dl" title="Download this chapter" href="/output/${encodeURIComponent(book)}/file/${esc(f)}?download=1">⬇</a>`
            : ''
        }
        <button class="sm" data-regen="${c.index}">↻</button></div>`;
        })
        .join('') || '<span class="muted">No chapters found.</span>';
    // 🔴 PAINTED AFTER THE CHAPTER LIST, DELIBERATELY. This block was above it once, and any
    // failure in it — a missing element, an undefined field — aborted loadOutput() before the
    // chapters rendered, so a cosmetic addition could empty the list of a 43-chapter book. A
    // panel that reports on the list must never be able to take the list down with it.
    const rw = $('outReclaimWrap');
    if (rw) {
      const wavMasters = o.chapters.filter(c => c.wav && /\.wav$/i.test(c.wav)).length;
      // 🔴 SAY WHETHER THE MASTERS ARE THE ONLY COPY. The render DELETES a chapter's master the
      // moment its MP3 is written (book_to_audio.py:831) — so a surviving master means that
      // chapter's encode never completed and the master is all there is. Describing those as
      // "duplicates beside the MP3s" is exactly backward and would invite deleting them.
      const onlyCopy = o.wav_only || 0;
      rw.innerHTML = o.wav_bytes
        ? `${
            onlyCopy
              ? `<div class="small" style="color:var(--warn)"><b>${onlyCopy} chapter${onlyCopy === 1 ? '' : 's'} unfinished</b> — rendered, but never turned into a finished chapter. The audio is fine; ${onlyCopy === 1 ? 'it is' : 'they are'} just not in the book yet.</div>
             <button class="sm go" id="outFinish" style="margin-top:6px" title="Complete them. A chapter whose working file is already Opus is moved into place — no re-encode, no quality loss, and it takes seconds. A WAV one is encoded to Opus 192k.">✅ Finish ${onlyCopy} chapter${onlyCopy === 1 ? '' : 's'}</button>`
              : ''
          }
           <div class="small muted" style="margin-top:6px">Working files: <b>${fmtSize(o.wav_bytes)}</b>${wavMasters ? ` (${wavMasters} still WAV)` : ''} · finished chapters: ${fmtSize(o.mp3_bytes)}</div>
           ${wavMasters ? `<button class="sm" id="outToOpus" style="margin-top:4px" title="Re-encode the WAV working files to Opus 192k in place. Nothing is deleted; each is replaced by a smaller one.">🎚 Convert working files to Opus</button>` : ''}
           <button class="sm" id="outReclaim" style="margin-left:8px" title="DELETE working files that already have a finished chapter beside them. Never touches one that is the only copy.">🗑 Reclaim</button>`
        : '';
      if (onlyCopy) /** @type {VEl} */ ($('outFinish')).onclick = () => outFinish(book, o);
      if (o.wav_bytes) /** @type {VEl} */ ($('outReclaim')).onclick = () => outReclaim(book, o);
      // 🔴 `o.wav_bytes &&` IS THE FIX, AND IT IS NOT DEFENSIVE PADDING — IT MATCHES THE PAINT.
      // The block above is `rw.innerHTML = o.wav_bytes ? … : ''`, so nothing here exists when
      // `wav_bytes` is 0. But `wavMasters` counts a chapter whose `wav` is merely PRESENT
      // (`book_state.py:404` sets it from `wav.name if wav_st else None`), while `wav_bytes` sums
      // `wav_size` (:439). A ZERO-BYTE working .wav — what an aborted render leaves — makes
      // `wavMasters` 1 and `wav_bytes` 0, so this read null and threw.
      //
      // ⚠️ AND THE THROW DID NOT COST A BUTTON, IT COST THE PAGE. `loadOutput`'s own catch
      // replaces `#outList` with the error text, so a 43-chapter book rendered as one red line —
      // a whole book looking destroyed because one working file was empty.
      //
      // 📌 THE TWO SIBLINGS ABOVE ARE SAFE AND STAY AS THEY ARE: `if (o.wav_bytes)` is the paint
      // condition verbatim, and `onlyCopy` is `wav_only`, which `book_state.py:446` counts only
      // for rows with a truthy `wav_size` — so `wav_only > 0` implies `wav_bytes > 0`.
      if (wavMasters && o.wav_bytes) /** @type {VEl} */ ($('outToOpus')).onclick = () => outToOpus(book, o);
    }
  } catch (e) {
    /** @type {VEl} */ ($('outList')).innerHTML = `<span class="drop">${esc(/** @type {ErrLike} */ (e).message)}</span>`;
  }
}
/** @type {VEl} */ ($('outList')).addEventListener('click', async e => {
  const i = /** @type {HTMLElement} */ (e.target).dataset.regen;
  if (i === undefined) return;
  const ok = await modal('Regenerate chapter', `Delete and re-render chapter ${+i + 1} with the current voice/params?`, [
    { label: 'Cancel', value: 0 },
    { label: 'Regenerate', class: 'primary', value: 1 },
  ]);
  if (!ok) return;
  /** @type {HTMLButtonElement} */ (e.target).textContent = '…';
  /** @type {HTMLButtonElement} */ (e.target).disabled = true;
  try {
    const r = await jpost(`/book/regenerate/${encodeURIComponent(/** @type {string} */ (state.curBook))}/${i}`, {});
    const poll = setInterval(async () => {
      try {
        const s = await jget('/book/status/' + r.job_id);
        if (['done', 'failed', 'canceled'].includes(s.status)) {
          clearInterval(poll);
          if (state.curBook) loadOutput(state.curBook); // the book can be deleted while this poll runs
        }
      } catch (err) {
        clearInterval(poll);
        if (state.curBook) loadOutput(state.curBook); // the book can be deleted while this poll runs
      }
    }, 2000); // stop polling if the status call ever errors (server restart, 404) — no runaway interval
  } catch (e2) {
    await modal('Regen failed', esc(/** @type {ErrLike} */ (e2).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    if (state.curBook) loadOutput(state.curBook); // the book can be deleted while this poll runs
  }
});
function concatFormatLabel() {
  const format = /** @type {HTMLSelectElement} */ ($('outConcatFormat')).value;
  return ({ opus: 'Opus', mp3: 'MP3', aac: 'AAC (Apple)' })[format] || 'Opus';
}

/** @param {FullAudiobook[]|null|undefined} exports */
function updateConcatLabel(exports) {
  const format = /** @type {HTMLSelectElement} */ ($('outConcatFormat')).value;
  const extension = ({ opus: '.opus', mp3: '.mp3', aac: '.m4a' })[format] || '.opus';
  const exists = (exports || []).some(a => String(a.file).toLowerCase().endsWith(extension));
  /** @type {VEl} */ ($('outConcat')).textContent = `${exists ? '↻ Rebuild' : '⚙ Create'} single audiobook (${concatFormatLabel()})`;
}

/** @type {HTMLSelectElement} */ ($('outConcatFormat')).onchange = () => {
  const current = state.books?.find(row => row.book === state.curBook);
  updateConcatLabel(current?.full_audiobooks);
};

// ⚙ Create single audiobook, built from chapter masters when present
// and otherwise from the finished encoded chapters (Opus or MP3).
// A stream copy of unchanged chapters is deterministic, so it landed identical bytes every time
// and looked like a no-op.
// It can produce something different now, and the button says what it will make.
/** @type {VEl} */ ($('outConcat')).onclick = async () => {
  if (!state.curBook) return;
  const book = state.curBook;
  const format = /** @type {HTMLSelectElement} */ ($('outConcatFormat')).value;
  const bitrate = Number(/** @type {HTMLSelectElement} */ ($('outConcatBitrate')).value);
  /** @type {HTMLButtonElement} */ ($('outConcat')).disabled = true;
  /** @type {HTMLSelectElement} */ ($('outConcatFormat')).disabled = true;
  /** @type {HTMLSelectElement} */ ($('outConcatBitrate')).disabled = true;
  /** @type {VEl} */ ($('outConcat')).textContent = 'Building…';
  try {
    const r = await jpost(`/output/${encodeURIComponent(book)}/concat`, { format, bitrate });
    // Refresh the shelf row and selected details as soon as the file exists, so its download
    // appears above the chapters without requiring a manual refresh or a second selection.
    await loadLibrary();
    // A long build may finish after another book was selected. Keep the shelf highlight and
    // chapter actions on that current selection rather than reopening the completed book.
    if (state.curBook) await loadOutput(state.curBook);
    const short = r.book_duration_s && r.duration_s && r.duration_s < r.book_duration_s * 0.98;
    await modal(
      'Single audiobook created',
      `${esc(r.file)} — <b>${fmtDur(r.duration_s)}</b>, ${fmtSize(r.size)}, from ${r.chapters} chapter${r.chapters === 1 ? '' : 's'}.
       ${short ? `<div class="small" style="margin-top:8px;color:var(--warn)">⚠ The book's chapters total <b>${fmtDur(r.book_duration_s)}</b> — this file is shorter. Some chapter audio did not go in.</div>` : ''}`,
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
  } catch (e) {
    await modal('Concat failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    /** @type {HTMLButtonElement} */ ($('outConcat')).disabled = false;
    /** @type {HTMLSelectElement} */ ($('outConcatFormat')).disabled = false;
    /** @type {HTMLSelectElement} */ ($('outConcatBitrate')).disabled = false;
    const current = state.books?.find(row => row.book === state.curBook);
    updateConcatLabel(current?.full_audiobooks);
  }
};
// 🎚 Convert masters to Opus (7.5.27) — re-encode in place, keeping every chapter.
//
// 🔴 THE WORK RUNS IN THE SERVICE BECAUSE THAT IS WHERE THE KEY IS. The book tree is encrypted
// at the application layer and the DEK lives in the running process's memory, so no CLI tool and
// no other process can read these files at all — a standalone script sees base64 filenames and
// an empty book. That is why this operation belongs in the app.
//
// Minutes of ffmpeg for a long book, so it is a thread server-side and this polls.
/**
 * @param {string} book
 * @param {BookOutput} o
 */
async function outToOpus(book, o) {
  const ok = await modal(
    'Convert masters to Opus',
    `Re-encode this book's <b>WAV chapter masters</b> to <b>Opus 192k</b>, in place.
     <div class="small" style="margin-top:8px">Every chapter is kept — each master is replaced by a smaller one, nothing is deleted. Expect roughly <b>${fmtSize(o.wav_bytes)} → ${fmtSize(Math.round((o.wav_bytes * 192) / 1411))}</b>.</div>
     <div class="small muted" style="margin-top:8px">The per-chapter MP3s and the single audiobook are untouched. This takes a few minutes for a long book.</div>`,
    [
      { label: 'Cancel', value: 0 },
      { label: '🎚 Convert', class: 'primary', value: 1 },
    ],
  );
  if (!ok) return;
  const btn = /** @type {HTMLButtonElement} */ ($('outToOpus'));
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Converting…';
  }
  try {
    await jpost(`/book/${encodeURIComponent(book)}/convert`, {});
  } catch (e) {
    await modal('Convert failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    loadOutput(book);
    return;
  }
  const poll = setInterval(async () => {
    let s;
    try {
      s = await jget(`/book/${encodeURIComponent(book)}/convert/status`);
    } catch (e) {
      clearInterval(poll);
      loadOutput(book);
      return;
    }
    if (s.status === 'running') {
      if (btn) btn.textContent = `Converting ${s.done || 0}/${s.total || '…'}`;
      return;
    }
    clearInterval(poll);
    if (s.status === 'done') {
      await modal(
        'Converted',
        `Freed <b>${fmtSize(s.freed_bytes || 0)}</b> across ${(s.converted || []).length} chapter${(s.converted || []).length === 1 ? '' : 's'}.
         ${(s.failed || []).length ? `<div class="small" style="margin-top:8px;color:var(--warn)">${s.failed.length} chapter${s.failed.length === 1 ? '' : 's'} could not be encoded and ${s.failed.length === 1 ? 'was' : 'were'} left as WAV.</div>` : ''}`,
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
    } else if (s.status === 'failed')
      await modal('Convert failed', esc(s.error || 'the conversion stopped'), [{ label: 'OK', class: 'primary', value: 1 }]);
    loadOutput(book);
  }, 2000);
}

// ✅ Finish chapters (7.5.36) — the exit from the zombie state.
//
// A chapter with a working file and no finished file was un-playable, un-reclaimable (it is
// the only copy, so Reclaim correctly refuses it) and had NO action anywhere that would
// complete it. An Opus working file is renamed into place — already exactly what the encoder
// would produce, so re-encoding it would spend a lossy generation to arrive where we are.
/**
 * @param {string} book
 * @param {BookOutput} o
 */
async function outFinish(book, o) {
  const n = o.wav_only || 0;
  const ok = await modal(
    'Finish these chapters',
    `Complete <b>${n}</b> chapter${n === 1 ? '' : 's'} that ${n === 1 ? 'was' : 'were'} rendered but never finished.
     <div class="small" style="margin-top:8px">Working files that are already Opus are <b>moved into place</b> — no re-encode, no quality loss. Any still in WAV are encoded to Opus 192k.</div>
     <div class="small muted" style="margin-top:8px">Nothing is deleted until its finished chapter is on disk.</div>`,
    [
      { label: 'Cancel', value: 0 },
      { label: `✅ Finish ${n}`, class: 'go', value: 1 },
    ],
  );
  if (!ok) return;
  const btn = /** @type {HTMLButtonElement} */ ($('outFinish'));
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Finishing…';
  }
  try {
    await jpost(`/book/${encodeURIComponent(book)}/finish`, {});
  } catch (e) {
    await modal('Failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    loadOutput(book);
    return;
  }
  const poll = setInterval(async () => {
    let s;
    try {
      s = await jget(`/book/${encodeURIComponent(book)}/convert/status`);
    } catch (e) {
      clearInterval(poll);
      loadOutput(book);
      return;
    }
    if (s.status === 'running') {
      if (btn) btn.textContent = `Finishing ${s.done || 0}/${s.total || '…'}`;
      return;
    }
    clearInterval(poll);
    if (s.status === 'done')
      await modal(
        'Chapters finished',
        `<b>${s.finished || 0}</b> chapter${s.finished === 1 ? '' : 's'} completed${(s.promoted || []).length ? ` — ${s.promoted.length} moved into place, ${(s.encoded || []).length} encoded` : ''}.
         ${(s.failed || []).length ? `<div class="small" style="margin-top:8px;color:var(--warn)">${s.failed.length} could not be finished and ${s.failed.length === 1 ? 'is' : 'are'} untouched.</div>` : ''}`,
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
    else if (s.status === 'failed') await modal('Failed', esc(s.error || 'it stopped'), [{ label: 'OK', class: 'primary', value: 1 }]);
    loadOutput(book);
  }, 1500);
}

// 🗑 Reclaim — drop the chapter WAVs, keep everything you listen to (7.5.27).
//
// This is the option that did not exist. ⚠ Clear all rmtree's the whole book directory and the
// concatenated audiobook lives INSIDE it, so "clear the chapters, keep the audiobook I just
// made" — the obvious reading of a button sitting next to ⚙ Create single audiobook — was not
// something the app could do; that action removes the chapter outputs it concatenated.
//
// 🔴 The dry run is not a nicety. It is the server's own answer to "what exactly would go",
// asked BEFORE the confirm, so the number in the modal is measured rather than predicted — and
// so `kept_only_copy` (chapters whose WAV has no MP3 beside it) can be named. Those are never
// deleted, and a count the user cannot see would make the reclaim look like it under-delivered.
/**
 * @param {string} book
 * @param {BookOutput} o
 */
async function outReclaim(book, o) {
  const fullExports = o.full_audiobooks || [];
  const fullBytes = fullExports.reduce((total, audiobook) => total + audiobook.size, 0);
  let plan;
  try {
    plan = await jpost(`/book/${encodeURIComponent(book)}/reclaim`, { dry_run: true });
  } catch (e) {
    await modal('Reclaim failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  if (!plan.deleted.length) {
    await modal('Nothing to reclaim', 'Every chapter here is stored only once — there are no WAV masters sitting beside an MP3.', [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  const kept = plan.kept_only_copy.length;
  const ok = await modal(
    'Reclaim chapter masters',
    `Delete the lossless WAV for <b>${plan.deleted.length}</b> chapter${plan.deleted.length === 1 ? '' : 's'} and free <b>${fmtSize(plan.freed_bytes)}</b>.
     <div class="small" style="margin-top:8px">Kept: the ${fmtSize(o.mp3_bytes)} of MP3s the player uses${fullExports.length ? `, and ${fullAudioSize(fullBytes)} across completed audiobooks` : ''}. Only the WAV masters go.</div>
     ${kept ? `<div class="small" style="margin-top:8px;color:var(--warn)">${kept} chapter${kept === 1 ? ' has' : 's have'} <b>no MP3</b>, so its WAV is the only copy — those are left exactly as they are.</div>` : ''}
     <div class="small muted" style="margin-top:8px">Re-rendering a chapter later makes a new WAV. This cannot be undone.</div>`,
    [
      { label: 'Cancel', value: 0 },
      { label: `🗑 Free ${fmtSize(plan.freed_bytes)}`, class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  try {
    const r = await jpost(`/book/${encodeURIComponent(book)}/reclaim`, {});
    await modal(
      'Reclaimed',
      `Freed <b>${fmtSize(r.freed_bytes)}</b> from ${r.deleted.length} chapter${r.deleted.length === 1 ? '' : 's'}.`,
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    loadOutput(book);
  } catch (e) {
    await modal('Reclaim failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
}

/** @type {VEl} */ ($('outRename')).onclick = async () => {
  if (state.curBook) await renameBook(state.curBook);
};

/** @type {VEl} */ ($('outClear')).onclick = async () => {
  if (!state.curBook) return;
  const title = bookTitle(state.curBook);
  // 🔴 NAME THE AUDIOBOOK. The old text — "all chapters, MP3s and chunks" — is true and reads as
  // the per-chapter artifacts, which is not what happens: the rmtree takes the whole directory
  // and `<book>_full.mp3` is inside it. A warning that does not say what it destroys is the
  // defect, not the button.
  const ok = await modal(
    'Clear all output',
    `This deletes <b>everything</b> for <b>${esc(title)}</b> — every chapter WAV, every MP3, the chunk workspace, <b>and the single concatenated audiobook</b> if you have made one.
    <div class="small" style="margin-top:8px">To free space while <b>keeping</b> the MP3s and the audiobook, cancel and use <b>🗑 Reclaim</b> instead.</div>
    <div class="small muted" style="margin-top:8px">This cannot be undone.</div>`,
    [
      { label: 'Cancel', value: 0 },
      { label: 'Delete everything', class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  try {
    await jpost(`/book/clear/${encodeURIComponent(state.curBook)}`, { confirm: state.curBook });
    clearOutput();
    loadLibrary();
  } catch (e) {
    // the book is gone: empty the detail half, refresh the shelf
    await modal('Clear failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
};

// ── 8.9: the folder controls on the Library ─────────────────────────────────
// 🔴 8.9.13 — THE 4TH ARGUMENT IS WHAT BUYS `⇤ Remove from folder`. A shelf had two ways INTO a
// folder (the button on the folder row, and a drag) and no findable way out: the root's drop target
// is the divider under the folder block, which is a 6-pixel line. A top-level action provides
// a discoverable way back to the root. It reads the SAME
// `libSel` that `⇥ Move selected here` reads — one gesture, two destinations.
//
// 🔴 ONE RELOAD FOR THE ROW ACTIONS AND THE TOOLBAR ONE, AND IT BRANCHES ON THE ACTION.
// `⇤ Remove from folder` is a `move` like any other, and getting that wrong is invisible: each
// book's `.folder` stamp came DOWN WITH THE ROW, so a repaint from `state.books` after an un-file
// puts the cards straight back into the folder the server has just taken them out of. The store is
// right and the screen is wrong, and it corrects itself on the next unrelated refresh — which is
// what turns it into a bug report about something else, later.
//
// ⚠️ `open` AND `create` MUST NOT REFETCH. Opening a folder is pure UI state, and `folderCreate`
// has already refreshed the folder cache — a reload that always refetched would put a `/library`
// AND a `/book/jobs` on every folder click.
/** @param {string} act */
const libFolderReload = async act => {
  if (act === 'move') libSel.clear(); // the ticked books went where they were sent
  if (act === 'open' || act === 'create') renderLibrary();
  else await loadLibrary();
};
folderAddButton(LIB_SCOPE, 'libRefresh', libFolderReload, { selected: () => [...libSel] });
folderWire('libList', LIB_SCOPE, {
  reload: libFolderReload,
  selected: () => [...libSel],
  counts: () => {
    /** @type {Record<string, number>} */
    const n = {};
    for (const b of state.books || []) if (b.folder) n[b.folder] = (n[b.folder] || 0) + 1;
    return n;
  },
});
folderWireDrag('libList', LIB_SCOPE, { reload: libFolderReload, selected: () => [...libSel] });
// A tick needs no re-render — the checkbox already shows it — and repainting here would also
// close the chapters panel the user has open.
/** @type {VEl} */ ($('libList')).addEventListener('change', e => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (!t.classList || !t.classList.contains('libchk')) return;
  if (t.checked) libSel.add(t.value);
  else libSel.delete(t.value);
});
