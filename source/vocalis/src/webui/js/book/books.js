// book/books.js — the uploaded-document shelf: upload a .docx/.epub, pick one, inspect it, delete
// it (7.3-m6b).
//
// Moved verbatim from index.html's `── Book library (upload / browse / inspect / delete) ──`
// banner: 38 lines, three definitions and four wirings. This is the SOURCE library — the documents
// Vocalis renders FROM. `js/book/library.js` is the OUTPUT library, the audio it renders TO. Two
// different shelves, two different endpoints (`/books` vs `/output`), and the names have been
// confusable since 4.1; the banner text is the disambiguator and it is quoted above on purpose.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — two names, and only two, because that is what the measurement said.
//
//   loadBooks     refills #bookSelect from GET /books. Boot awaits it; ↻ Refresh calls it; upload
//                 and delete both call it to re-read the shelf they just changed
//   restoreBook   re-selects the book the user was last on, from server-side UI state. Boot only
//
// PRIVATE — and `selectBook` being private is the finding, not an accident:
//
//   selectBook    ⚠️ IT LOOKED LIKE THE MAIN EXPORT AND HAS NO CALLER OUTSIDE THIS FILE. Five call
//                 sites, measured: `restoreBook`, the #bookSelect change listener, the upload
//                 handler's tail, the delete handler's tail, and nothing else in the page or the
//                 module tree. It reads like the feature's front door because it is the one that
//                 does the work — but every door into it is in this file, so publishing it would
//                 hand outside code a way to change the current book without the shelf, the
//                 remembered selection and the chapter list agreeing about it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ `loadBooks` LEAVES `_PARSE_TIME_SURFACE`, AND IT LEAVES THE EASY WAY (the m4r shape).
//
//     $('bookRefresh').onclick=loadBooks;        ← a BARE VALUE, read during parsing (§11.8)
//
// The pin's own note said this one "moves with `book/library.js`, m6", which was the right
// milestone and the wrong file — see the header line above about the two shelves. It is the FOURTH
// name to leave the pin and the SECOND to leave it without an arrow: the wiring statement sits
// INSIDE the moved range, so it traveled with the function and now resolves against a hoisted
// local declaration. `renderLibrary` (m4l) and `vsRenderLib` (m4p) both needed `()=>renderX()`
// because their `filtWire` call sites belong to a block that is nobody's feature. Nothing is left
// behind in the page here at all, which is the whole argument for preferring this form.
//
// ⚠️ SO THE FOUR WIRINGS BELOW ARE LOAD-BEARING. This module's import is not just its two exports:
// drop it and ↻ Refresh, ⬆ Upload, Delete and the book <select> all go silently dead, with no
// ReferenceError to say so — the same shape as `voice/rvcimport.js` (m4r), one step milder because
// two names do come back out.
//
// 📌 `renderChaps` IS AN IMPORT AS OF THIS COMMIT, not an inline reach. m6a landed it in
// `book/parse.js` one commit earlier, which is the only reason this file reaches for nothing but
// `UIS` and `state`. Ordering the two cuts parse-then-books is the same call m4o→m4p made with the
// ★: do the one the other depends on first and the second is a straight move.
//
// ⚠️ `UIS` AND `state` ARE STILL INLINE GLOBALS, resolved at call time through the scope chain
// (§3.1, module→inline, always safe). `UIS` cannot become a module at all before m13 — §11.2 —
// and `state` moves at m12 with the rest of the page's shared state.

import { $, esc } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { fmtSize } from '../util/fmt.js';
import { jget } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { renderChaps } from './parse.js';

/**
 * A row of `/books` — `web/books.py`'s `books_list()`: an uploaded SOURCE document (the shelf
 * you render FROM), not to be confused with the central `BookRow` (`/library`'s rendered-output
 * shelf) — same word, two different endpoints, see this file's header.
 * @typedef {object} SourceBook
 * @property {string} name
 * @property {number} size
 */
/**
 * `/books/<name>/inspect` — `web/books.py`'s `books_inspect()`.
 * @typedef {object} BookInspect
 * @property {string} name
 * @property {number} size
 * @property {string} path
 * @property {Chapter[]} chapters
 * @property {number} words
 * @property {number} chars
 */
export async function loadBooks() {
  try {
    const books = /** @type {SourceBook[]} */ (await jget('/books'));
    const cur = /** @type {HTMLSelectElement} */ ($('bookSelect')).value;
    /** @type {VEl} */ ($('bookSelect')).innerHTML =
      '<option value="">— select an uploaded book —</option>' +
      books.map(b => `<option value="${esc(b.name)}">${esc(b.name)} · ${fmtSize(b.size)}</option>`).join('');
    if (books.some(b => b.name === cur)) /** @type {HTMLSelectElement} */ ($('bookSelect')).value = cur;
  } catch (e) {}
}
/** @param {string} name */
async function selectBook(name) {
  try {
    UIS.setItem('vocalis-book-select', name || '');
  } catch (e) {} // survives a reload (change/upload/delete all pass through here)
  if (!name) {
    /** @type {VEl} */ ($('bookDetails')).textContent = '';
    /** @type {VEl} */ ($('chapsWrap')).style.display = 'none';
    /** @type {HTMLButtonElement} */ ($('runBtn')).disabled = true;
    state.chapters = [];
    return;
  }
  /** @type {VEl} */ ($('bookDetails')).innerHTML = '<span class="muted">Inspecting…</span>';
  try {
    const o = /** @type {BookInspect} */ (await jget('/books/' + encodeURIComponent(name) + '/inspect'));
    /** @type {HTMLInputElement} */ ($('path')).value = o.path;
    /** @type {VEl} */ ($('bookDetails')).innerHTML =
      `📄 <b>${esc(o.name)}</b> · ${fmtSize(o.size)} · ${o.chapters.length} chapters · ${o.words.toLocaleString()} words`;
    renderChaps(o.chapters);
  } catch (e) {
    /** @type {VEl} */ ($('bookDetails')).innerHTML = `<span class="drop">${esc(/** @type {ErrLike} */ (e).message)}</span>`;
    /** @type {HTMLButtonElement} */ ($('runBtn')).disabled = true;
  }
}
export async function restoreBook() {
  let n = '';
  try {
    n = UIS.getItem('vocalis-book-select') || '';
  } catch (e) {}
  if (n && [.../** @type {HTMLSelectElement} */ ($('bookSelect')).options].some(o => o.value === n)) {
    /** @type {HTMLSelectElement} */ ($('bookSelect')).value = n;
    await selectBook(n);
  }
}
/** @type {VEl} */ ($('bookSelect')).addEventListener('change', e => selectBook(/** @type {HTMLSelectElement} */ (e.target).value));
/** @type {VEl} */ ($('bookRefresh')).onclick = loadBooks;
/** @type {VEl} */ ($('bookUpload')).onclick = async () => {
  const f = /** @type {FileList} */ (/** @type {HTMLInputElement} */ ($('bookFile')).files)[0];
  if (!f) {
    await modal('No file', 'Choose a .docx or .epub first.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  /** @param {boolean} overwrite */
  async function up(overwrite) {
    const fd = new FormData();
    fd.append('file', f);
    if (overwrite) fd.append('overwrite', 'true');
    return fetch('/books', { method: 'POST', body: fd });
  }
  /** @type {HTMLButtonElement} */ ($('bookUpload')).disabled = true;
  /** @type {VEl} */ ($('bookUpload')).textContent = 'Uploading…';
  try {
    let r = await up(false);
    let j = await r.json().catch(() => ({}));
    if (r.status === 409) {
      const ok = await modal('Overwrite?', `<b>${esc(j.name)}</b> already exists in the library. Overwrite it?`, [
        { label: 'Cancel', value: 0 },
        { label: 'Overwrite', class: 'danger', value: 1 },
      ]);
      if (!ok) {
        return;
      }
      r = await up(true);
      j = await r.json().catch(() => ({}));
    }
    if (!r.ok) throw new Error(j.error || r.statusText);
    /** @type {HTMLInputElement} */ ($('bookFile')).value = '';
    await loadBooks();
    /** @type {HTMLSelectElement} */ ($('bookSelect')).value = j.name;
    selectBook(j.name);
  } catch (e) {
    await modal('Upload failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    /** @type {HTMLButtonElement} */ ($('bookUpload')).disabled = false;
    /** @type {VEl} */ ($('bookUpload')).textContent = '⬆ Upload';
  }
};
/** @type {VEl} */ ($('bookDelete')).onclick = async () => {
  const name = /** @type {HTMLSelectElement} */ ($('bookSelect')).value;
  if (!name) {
    await modal('No book', 'Select a book to delete.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  const ok = await modal(
    'Delete book',
    `Delete <b>${esc(name)}</b> from the library? This removes the source document only — audio already rendered is untouched, and stays in Library.`,
    [
      { label: 'Cancel', value: 0 },
      { label: 'Delete', class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  try {
    const r = await fetch('/books/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    /** @type {HTMLInputElement} */ ($('path')).value = '';
    await selectBook('');
    await loadBooks(); // clears details/chapters AND the remembered selection
  } catch (e) {
    await modal('Delete failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
};
