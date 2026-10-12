// book/parse.js — pick a document, get its chapters, and say how long rendering it will take
// (7.3-m6a).
//
// Moved verbatim from index.html's `── Book: parse + run + SSE ──` banner: 32 lines, five
// definitions, no wirings. `POST /book/parse` turns a .docx/.epub into a chapter list;
// `renderChaps` is the ONE renderer for that list and every producer of one goes through it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE BANNER LIED, AND THE MEASUREMENT IS WHY THIS FILE IS 32 LINES AND NOT 183.
//
// `── Book: parse + run + SSE ──` names three things and contains one. The **run + SSE** half —
// `bookBody`, `runBook`, `openStream`, `setStrip`, `subLine`, `jobStart`, `handleEvent`, `endJob`,
// `setRunning`, `cancelJob` — sits ~180 lines further down the page, under the `── Nomi pairing
// (7.2-m4) ──` banner, because it has no banner of its own and the nearest one above it belongs to
// somebody else. `── Resume-on-reload ──` is the third piece, and it does have its own.
//
// §6 step 1 says to take the boundary from the banners because "they are accurate and they encode
// the author's intent". They usually are. **This is the second place in this page where they are
// not** — the first was the KoboldCpp/devices wiring that read as part of Nomi pairing in m4 for
// exactly the same reason. So the rule earned here, and now in §11.10:
//
//   🔴 CONFIRM THE BANNER AGAINST THE DEFINITIONS UNDER IT BEFORE YOU TRUST THE RANGE. A banner
//      names what its author was writing THAT DAY; code appended later inherits it by position,
//      and a banner that names three things and holds one is the tell.
//
// The run + SSE half is a separate commit on purpose (m6c). It is not more of the same: seven of
// its ten names are unprefixed generics — `endJob`, `setRunning`, `openStream`, `handleEvent` —
// and putting those on the shim's `Object.assign(window, …)` is a different question from moving
// three names nobody else could collide with. Answer it in its own commit, with its own reasoning.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — three names, all reached from outside, all safe on the shim.
//
//   parseBook       the Parse button. ⚠️ Its wiring is ALREADY in js/main.js (7.3-m4), which is
//                   what makes this cut mechanical — see the parse-time note below
//   renderChaps     the one chapter-list renderer. THREE callers outside this file: `handleEvent`'s
//                   `sections` case and `resumeRender` (both still inline, both the run half), and
//                   `selectBook` in js/book/books.js
//   loadRenderRate  refreshes the measured characters/sec. Called by `endJob` when a render
//                   finishes — that is the moment the number changes — and awaited once by boot
//
// PRIVATE, and staying that way:
//
//   rr              the measured rate. A `const` object, only ever mutated, so it WOULD be safe on
//                   the shim (§11.4) — but nothing outside reads it, and `rr` is a name three other
//                   functions in this page already use as a local `const` for a fetch Response.
//                   Publishing it would put a two-field object on `window.rr` under a name the page
//                   uses to mean something else four times over. Measured, not assumed: the only
//                   non-local hits are index.html:5076, 5097 and 5099, all `const rr=await fetch(…)`
//   renderEtaLine   one caller, `renderChaps`, three lines below it
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ NOTHING HERE IS PARSE-TIME REACHABLE, AND THAT IS NOT LUCK — m4 PAID FOR IT.
//
// `$('parseBtn').onclick=parseBook;` names `parseBook` as a BARE VALUE, which is evaluated during
// parsing exactly as hard as a call is (§11.8). While that statement was inline, `parseBook` had to
// be an inline global, and extracting it underneath would have thrown a ReferenceError mid-parse —
// killing every top-level statement after it, i.e. most of the page. §11.5 item 1 said so in
// advance and named this milestone: *"move that wiring into main.js before m6 touches either
// area"*. m4 moved it. So the prerequisite for this commit was discharged three milestones ago and
// there is nothing to defuse here — which is what the plan is for.
//
// 📌 `loadRenderRate` and `parseBook` become real `import`s in main.js in this commit. main.js must
// never reach a shim-published global (its own header says why: `import` is hoisted, so the shim's
// `Object.assign` has not run when main.js's body does). They are the 4th and 5th names to make
// that trip.
//
// ⚠️ THE LOG SINKS DID NOT COME. `logLine`, `pgLogLine` and `pgEnhTag` sat inside this banner's
// range and are not parse code: `logLine` belongs to the book JOB and `pgLogLine`/`pgEnhTag` to the
// Playground. m4g's rule — "the six sinks stay in the page and travel with their own areas" — is
// what kept them, and it is the same call m4o made when the ★ came out of the swap library first.
// Taking them here would have put Playground code in a file named `parse.js`.
//
// ⚠️ `state` IS STILL AN INLINE GLOBAL and is read and MUTATED here (`state.chapters`,
// `state.chapsDone`, `state.bookChars`, `state.running`). That is the module→inline direction and
// is resolved at CALL time, which is always safe (§3.1). It becomes an import at m12, with the
// rest of the page's shared state, and not before — declaring `state` in a module would fork it.

import { $, esc } from '../util/dom.js';
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { fmtEta } from '../util/fmt.js';
import { jget, jpost } from '../util/http.js';
import { modal } from '../ui/modal.js';
import { bkUpdateEnh } from '../sys/enhance.js';

// One renderer for the chapter list (parse, book-select, and SSE replay all use it);
// `done` = chapter indices to pre-mark as finished (resume-on-reload).
// The render's own ETA, BEFORE you commit — but only if this box has ever been measured.
// It has no fallback on purpose: a GPU-name lookup cannot account for active cards or shared
// workers. The estimate uses a measured rendering rate; until one is available, it says so.
const rr = { measured: false, rate: 0 };
export async function loadRenderRate() {
  try {
    const r = await jget('/render/rate');
    rr.measured = !!r.measured;
    rr.rate = r.rate || 0;
  } catch (e) {
    rr.measured = false;
  }
  if (state.chapters && state.chapters.length) renderChaps(state.chapters, state.chapsDone);
}
/** @param {number} chars */
function renderEtaLine(chars) {
  if (!chars) return '';
  if (!rr.measured)
    return ` · <span class="muted" title="This box has never rendered enough for Vocalis to know how fast it is, and it will not invent a number. Render a book and it measures itself — the estimate is there from then on.">render time: not measured yet</span>`;
  return ` · <span title="${rr.rate.toFixed(1)} characters/sec of wall clock, measured on this box — not looked up from a table of other people's cards.">~<b>${fmtEta(chars / rr.rate)}</b> to render</span>`;
}
/**
 * @param {Chapter[]|null|undefined} chapters
 * @param {number[]|null|undefined} [done] - chapter indices to pre-mark as finished (resume-on-reload).
 */
export function renderChaps(chapters, done) {
  state.chapters = chapters || [];
  state.chapsDone = done;
  const words = state.chapters.reduce((a, c) => a + (c.words || 0), 0);
  // Characters, not words: the measured constant that turns text into an AUDIO length is
  // per character (words vary in length), and that audio length is what the enhance ETA
  // is built from.
  state.bookChars = state.chapters.reduce((a, c) => a + (c.chars || 0), 0);
  bkUpdateEnh();
  /** @type {VEl} */ ($('chapsLabel')).innerHTML =
    `${state.chapters.length} chapters — ${words.toLocaleString()} words` + renderEtaLine(state.bookChars);
  /** @type {VEl} */ ($('chaps')).innerHTML = state.chapters
    .map(
      c =>
        `<div class="chap${done && done.includes(c.index) ? ' done' : ''}" data-ch="${c.index}"><span>[${String(c.index).padStart(2, '0')}] ${esc(c.title)}</span><span class="w">${(c.words || 0).toLocaleString()} words</span></div>`,
    )
    .join('');
  /** @type {VEl} */ ($('chapsWrap')).style.display = 'block';
  /** @type {HTMLButtonElement} */ ($('runBtn')).disabled = state.running || !state.chapters.length;
}
export async function parseBook() {
  const path = /** @type {HTMLInputElement} */ ($('path')).value.trim();
  if (!path) return;
  /** @type {HTMLButtonElement} */ ($('parseBtn')).disabled = true;
  /** @type {VEl} */ ($('parseBtn')).textContent = 'Parsing…';
  try {
    const r = await jpost('/book/parse', { path });
    renderChaps(r.chapters);
  } catch (e) {
    await modal('Parse failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    /** @type {HTMLButtonElement} */ ($('parseBtn')).disabled = false;
    /** @type {VEl} */ ($('parseBtn')).textContent = 'Parse';
  }
}
