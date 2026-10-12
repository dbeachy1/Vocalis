/** Own the World Book library, editor lifecycle, placement, and save/navigation chain. The picture picker shares this module because opening a card and applying a crop both update the roster. Only page and browser-test callers need exported functions.
 */
import { modal, wbAskName, wbConfirm } from '../ui/modal.js';
import { $, esc, wbEl } from '../util/dom.js'; // 7.3-m13: `$` was reached off the shim
import { UIS } from '../util/uistate.js'; // 7.3-m13
// ⚠️ 7.3-m2b: the retry in `wbGo` asks "is he still looking at this kind?" and read the bare
// `stTab` off the page to do it. 🔴 THIS IS THE READ THAT SAID SO — `ReferenceError: stTab is not
// defined at js/wb/open.js:230` — when m2b's first draft put that `let` in js/st/tabs.js, which
// imports FROM this file. js/st/tabstate.js imports nothing and exists for exactly that reason.
import { stTabNow } from '../st/tabstate.js';
import { wbFolded } from './edit.js'; // 7.3-m13: was a shim read
import { jdel, jget, jpost } from '../util/http.js';
// `wbSetEdits` is called by the save path and must remain in this import list. A long list can
// look complete while omitting one required binding.
import {
  wbDraftSetKey,
  wbEntryCtl,
  wbFilterPaint,
  wbFindClose,
  wbFoldPaint,
  wbFoldUnticked,
  wbGetAt,
  wbMarkDirty,
  wbMarkKeyless,
  wbMode,
  wbPreflight,
  wbSaveBusy,
  wbSaveDraft,
  wbSaveGate,
  wbSaveShow,
  wbKeysBuild,
  wbSetBuild,
  wbSetEdits,
  wbSetToggle,
  wbShutInit,
  wbShutToggle,
  wbSyncRowPending,
  wbTicked,
} from './edit.js';
import { wbFaceHtml, wbSyncCardZoomTitle } from './face.js';
import { wbWhen } from './fmt.js';
import { wbDocKind } from './kind.js';
import { wbLoadSavedLog, wbLogFold, wbLogStart, wbLogStop } from './log.js';
import { wbAddProposal, wbLoadInstructions, wbStream } from './pass.js';
import { runWbAction, wbHush, wbSay } from './say.js';
import { wbBump, wbGen, wbStale, wbState } from './state.js';

// ── shapes measured off this file's own reads, kept LOCAL. `edit.js`, `pass.js`, `apply.js`,
// `dl.js` and `log.js` touch the same server payloads and may want the same fields — that is a
// report item for whoever owns those files, not a reason to promote these into a shared .d.ts.

/** Metadata for one `/wbedit/documents?kind=` roster row. `avatar` indicates presence, not a URL; `pending` is a count, not a fetch state.
 * @typedef {object} WbDocRow
 * @property {string} id
 * @property {string} name
 * @property {string} kind
 * @property {number} latest
 * @property {number} pending
 * @property {number} [imported_at] - epoch seconds; missing reads as 0 (oldest, never a throw).
 * @property {string} [st_ref] - SillyTavern's own key; absent for anything Vocalis authored.
 * @property {boolean} avatar
 * @property {string} [avatar_at] - the picture's `(size, mtime)` in hex, `""` when there is none.
 *   9.5.12 — it goes in the <img> URL so a replaced face is re-fetched rather than served out of
 *   Chrome's per-page memory cache, which no response header reaches. Never parsed: it is an
 *   opaque token whose only property is that it changes with the bytes.
 * @property {string} [thumb_at] - 9.7.7 — the same idea for the ROSTER face, which points at
 *   `/thumb` rather than `/avatar` and so needs its own token: this one folds in the focus rect
 *   as well as the bytes, because a rect edit changes the crop and leaves `avatar_at` identical.
 * @property {{x:number,y:number,w:number}} [focus]
 * @property {string} [world_id] - §8.2's link, held as the BOOK'S DOCUMENT ID and never as its
 *   name, which is what makes renaming a book cost the association nothing. `''` when the card
 *   names no book we hold; see `world_name`/`world_held` on `WbDoc` for the resolved answer.
 * @property {string} [world_ref] - the name the CARD itself carries, frozen on import day. Never
 *   rendered — that is `wbShowWorld`'s whole rule — but it is what `link_orphan_cards` matches on.
 * @property {boolean} [world_set] - 9.7.3: The user chose this link in Vocalis, so it travels on a
 *   send. False for every link that merely arrived with the card.
 */

/** One row of `Document.revision_index` — the timestamp a revision picker labels itself with. */
/** @typedef {{n:number, created_at:number, pass_id?:string}} WbRevisionIndexEntry */

/** One row of `Document.passes`, as embedded in the full-document GET. */
/** @typedef {{id:string, status?:string, created_at?:number}} WbPassRow */

/**
 * A full document — `GET /wbedit/documents/<id>`. Everything a `WbDocRow` has, plus what is
 * only worth resolving for the ONE document actually being opened (wbedit.py:879).
 * @typedef {WbDocRow & {
 *   world_name?: string, world_held?: boolean,
 *   revisions: number[],
 *   revision_index: WbRevisionIndexEntry[],
 *   passes: WbPassRow[],
 * }} WbDoc
 */

/**
 * One row of the `/fields` checkbox list — `formats.collect()`'s wire shape (wbedit.py:993).
 * @typedef {object} WbField
 * @property {(string|number)[]} locator - same tuple shape `wbGetAt` (edit.js) walks: a dict key
 *   where the node is a compiled entry, a list index where it is a section chunk.
 * @property {string} label
 * @property {number} chars
 * @property {string} [mode] - '' means no injection mode; the UI draws no dot for it.
 * @property {string|null} [entry] - non-null only inside a compiled worldbook.
 * @property {string} [group] - the heading this field is drawn under; '' for most.
 * @property {boolean} [inert] - stored, but SillyTavern will never fire it (no keywords).
 * @property {boolean} [empty] - no text yet; the checkbox is disabled, never hidden.
 * @property {boolean} [pass_default]
 */

/**
 * One row of `entry_fields` — the settings-fold schema (`entryfields.spec_payload()`). Only
 * `.name` is read in this file; the fold body itself is built in `edit.js`.
 * @typedef {{name: string}} WbSpecField
 */

/** One row of a pass's `proposals` — `GET /wbedit/pass/<doc>/<pass>`. */
/** @typedef {{index:number, status?:string, review?:string}} WbProposalRow */

// Route a fire-and-forget async call's failure to the message line instead of the void.
//
// 🔴 `jget`/`jpost`/`jput`/`jdel` THROW on any non-2xx (:2337). ~34 call sites in this pane invoke
// an async function without `await` and without `.catch`, so a 409, a 423 (vault locked) or a
// dropped connection became an unhandled rejection and NOTHING APPEARED ANYWHERE — the button
// simply looked dead (5.7). This is not the §9a.30 spinner item; that spec assumes an error is
// still shown, and until now none was.
//
// ⚠️ Not a substitute for a real `try`/`catch` where the function needs to clean up after itself.
// This is the floor: no failure is silent.
/**
 * @param {string} kind — which editor sub-tab this pane belongs to ('cards'/'books'/'personas').
 * @param {Promise<unknown>} p — the fire-and-forget call. Never awaited by the caller; this is
 *   what makes its rejection land on the message line instead of the console.
 */
export function wbGo(kind, p) {
  return Promise.resolve(p).catch(e => {
    if (e && e.status === 423) {
      wbSay(kind, 'The vault is locked.', 'bad');
      return;
    }
    wbSay(kind, e && e.message ? e.message : 'That did not work.', 'bad');
  });
}

// Close the pass stream this pane is holding, if any (5.2).
//
// ⚠️ THE STREAM ONLY. It deliberately leaves `st.pass`, `st.seen` and the proposals alone: those
// are read by `wbApply`, `wbReview` and the review queue that may still legitimately be on screen,
// and tearing them down here turned a stream-lifetime fix into a review-queue bug in testing.
// The stream is the part that is *wrong* after a switch, because `es.onmessage` fires
// `wbFetchProposal` against whatever `st.doc.id` has become by the time the frame lands.
//
// 🔴 CALL THIS FROM EVERY PATH THAT STOPS SHOWING A DOCUMENT — open, close, delete, tab switch.
// `wbStream` closing its own predecessor (`if(st.es) st.es.close()`) only covers a SECOND pass on
// the same pane, which is the one case that was never the problem.
//
// ⚠️ NOT `wbStreamStop`, AND THE NAME IS LOAD-BEARING. `wbedit_ui_smoke.mjs` slices functions out
// of this file with `indexOf('function wbStream')`, so a name that has `wbStream` as a PREFIX and
// sits earlier in the file silently redirects that slice — the §7 one-pass-gate checks went red
// against code that was completely fine. Same trap the browser roster now forbids for check names
// (no name may be a prefix of another), for the same reason.
/** @param {string} kind */
function wbCloseStream(kind) {
  const st = wbState(kind);
  if (st.es) {
    st.es.close();
    st.es = null;
  }
}

// 🔴 `WB_KIND` AND `wbDocKind` NOW LIVE IN `js/wb/kind.js` (7.1 §5.5) — a move, not a copy, because
// nothing reaches them at parse time. The callers below still say `WB_KIND` and `wbDocKind`
// unqualified and reach them through the shim at the bottom of this file. The 🔴 note about why the
// tab key is not the document kind moved with them; it belongs next to the map, not next to a
// pointer at the map.

//: One pending locked-vault retry per pane. Keyed so the two sub-tabs cannot stack timers on
//: each other, and cleared before the retry runs so a still-locked vault schedules exactly one
//: more rather than compounding.
/** @type {Record<string, ReturnType<typeof setTimeout>|null>} */
const wbLockTimer = { cards: null, books: null };

/** @param {string} kind */
async function wbLoadModel(kind) {
  try {
    const m = await jget('/wbedit/model');
    // 11.1 — the ENGINE is named beside the model, because a hosted one means the fields leave
    // this box and that has to be visible before a pass, not discovered in its log. The chosen
    // engine is set on the LLM tab ("Worldbook editor uses"); KoboldCpp's "no model loaded"
    // wording is unchanged, and the other engines say what is missing.
    const eng = m.engine_label ? ' (' + m.engine_label + ')' : '';
    /** @type {VEl} */ (wbEl(kind, 'wbModel')).textContent =
      m.loaded && m.model
        ? 'model: ' + m.model + eng
        : m.engine && m.engine !== 'kobold' && m.error
          ? m.engine_label + ': ' + m.error
          : 'no model loaded';
    /** @type {VEl} */ (wbEl(kind, 'wbModel')).className = 'small ' + (m.loaded && m.model ? 'muted' : 'warn');
    // 11.1.6 — on a narrow window the header's buttons leave this readout its 8em floor and it
    // ellipsizes, so the tooltip carries the whole line ahead of the markup's explanation.
    const me = /** @type {VEl} */ (wbEl(kind, 'wbModel'));
    if (me.dataset.why == null) me.dataset.why = me.title;
    me.title = me.textContent + '\n\n' + me.dataset.why;
  } catch (e) {
    /** @type {VEl} */ (wbEl(kind, 'wbModel')).textContent = '';
  }
}

// ── the Library pane ─────────────────────────────────────────────────────
// §8.2 — which worldbook the Character Cards roster is filtered to. '' is all of them, 'none' is
// the cards associated with no book. Deliberately NOT persisted: a filter that survives a reload
// is a library that looks half-empty for a reason the page no longer shows.
let wbBookFilter = '';

/** Set the module-local book filter through a function so callers do not assign to a read-only imported binding or a stale window copy.
 */
/** @param {string} v — a document id, `'none'`, or `''` for "all worldbooks". */
export function wbSetBookFilter(v) {
  wbBookFilter = v;
}

// The books to choose between. Reload from the server so imports and renames on the other sub-tab
// are reflected here.
export async function wbLoadBookFilter() {
  const sel = document.getElementById('wbBook_cards');
  if (!sel) return;
  try {
    /** @type {{id:string, name:string}[]} */
    const books = (await jget('/wbedit/documents?kind=worldbook')).documents;
    // 🔴 A FILTER POINTING AT A BOOK THAT IS GONE MUST NOT SURVIVE. Deleted out from under us,
    // it would hide every card and the control would show a blank selection — an empty roster
    // with nothing on screen saying why. Fall back to showing everything.
    if (wbBookFilter && wbBookFilter !== 'none' && !books.some(d => d.id === wbBookFilter)) wbBookFilter = '';
    sel.innerHTML =
      '<option value="">All worldbooks</option>' +
      '<option value="none">— not associated —</option>' +
      books.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
    /** @type {HTMLSelectElement} */ (sel).value = wbBookFilter;
    // 🔴 ASSIGNING A `value` THAT MATCHES NO OPTION SILENTLY LEAVES `''`. The control would then
    // read "All worldbooks" while `wbBookFilter` still held the missing id, and the roster would
    // be filtered by something the page is not showing — a library that looks wrong with nothing
    // on screen explaining why. Believe the control, not the variable.
    wbBookFilter = /** @type {HTMLSelectElement} */ (sel).value;
    sel.style.display = books.length ? '' : 'none'; // nothing to filter by yet
  } catch (e) {
    // Locked, or unreachable. `wbLoadLib` is about to say so properly; a dropdown that lists
    // nothing would read as "you have no worldbooks", which is the one thing it must not claim.
    sel.style.display = 'none';
  }
}

/** @param {string} kind */
export async function wbLoadLib(kind) {
  // A library reload may follow an import, edit or rename, so every pre-rendered snapshot must be
  // discarded before the new roster starts warming. In-flight warmers self-cancel by generation.
  wbClearBookWarm(kind);
  wbLoadModel(kind);
  wbLoadInstructions(kind);
// Await this request so the dropdown includes books imported on the World Books pane during this
// session:
  // not in the list — and picking a book that is not in the list yet leaves the select on ''. The
  // filter then silently does nothing, which is worse than an error because it looks like an
  // answer. This also lets the stale-filter reset above take effect on the SAME load.
  if (kind === 'cards') await wbLoadBookFilter();
  const box = /** @type {VEl} */ (wbEl(kind, 'wbLib'));
// Grab the editor node before clearing the container and before any early return. If it is
// parked among these rows, writing `box.innerHTML` detaches it; a detached node cannot be found
// by ID, and the editor's current contents would be lost. This is the same hazard `scPlace()`
// handles for the shared <audio> element.
  //
// Keep the node reference before every branch that can replace `innerHTML`; the empty-result,
// error, and locked-vault paths also repaint this container.
  const pane = wbPane(kind);
  /** @param {string} html */
  const wbSet = html => {
    box.innerHTML = html;
    wbPlaceEditor(kind, pane);
  };
  const filtered = kind === 'cards' && wbBookFilter;
  try {
    const r = await jget(
      '/wbedit/documents?kind=' + encodeURIComponent(wbDocKind(kind)) + (filtered ? '&world=' + encodeURIComponent(wbBookFilter) : ''),
    );
    if (!r.documents.length) {
// An empty result under the active filter is different from an empty library. An empty RESULT and
// an empty LIBRARY are different facts (the `list_options`
      // rule again — never render an ambiguity as the more alarming certainty).
      wbSet(
        filtered
          ? '<span class="muted">No character cards are associated with that worldbook' +
              (wbBookFilter === 'none' ? '' : ' yet') +
              '. Pick “All worldbooks” to see the rest.</span>'
          : // 🔴 THE EMPTY STATE NAMES EXACTLY THE BUTTONS THAT ARE ON THE PANE, and this branch
            // exists because that has now been wrong twice in opposite directions. §8.3 wrote it
            // to avoid pointing at an ⬆ Import that was not there; 9.5.12 built one, at which
            // point the same sentence was telling him there was nothing to upload while the
            // control sat six inches above it. Three doors, all three named.
            wbDocKind(kind) === 'persona'
            ? '<span class="muted">Nothing here yet. Press ⟳ Import from SillyTavern with a ' +
              'SillyTavern tab open, ⬆ Import file… for a .json persona or a .md write-up, or ' +
              '✚ New Persona to write one here.</span>'
            : '<span class="muted">Nothing imported yet. Use ⬆ Import to bring in a ' +
              (wbDocKind(kind) === 'card' ? 'character card (.png or .json)' : 'worldbook') +
              ' exported from SillyTavern.</span>',
      );
      return;
    }
// Two documents can share a name and image, leaving identical roster rows beside destructive
// controls. Show a discriminator only where a name collision makes it necessary.
    //
// Storage identity remains `st_ref`; this is a display distinction, not a data change. Avoid
// showing that key on rows whose names are already unambiguous.
    /** @type {Record<string, number>} */
    const wbDupName = {};
    for (const d of /** @type {WbDocRow[]} */ (r.documents)) wbDupName[d.name] = (wbDupName[d.name] || 0) + 1;
// Provide a backup download on each row without opening the document.
    //
    // ⚠️ BUILT ONCE PER LOAD, NOT PER ROW: the sentence depends on the PANE's kind, and a card
    // comes out as the PNG (with its picture) while a book and a persona come out as JSON. Saying
    // "a .json file" over a roster of cards would be a tooltip that is wrong on every row.
    // 🔴 It downloads the LATEST revision, because a row is not showing a revision at all — the
    // editor's own ⬇ Export is the control for "this older one", and says so.
    const dlTip =
      wbDocKind(kind) === 'card'
        ? 'Save the latest revision of this card as the .png SillyTavern imports — the picture ' +
          'and the character in one file. Chrome and Edge ask where to put it; other browsers use ' +
          'your downloads folder. Nothing here changes, and SillyTavern is not affected.'
        : 'Save the latest revision as a .json file you can keep as a backup and import again ' +
          'later. Chrome and Edge ask where to put it; other browsers use your downloads folder. ' +
          'Nothing here changes, and SillyTavern is not affected.';
    /** @param {WbDocRow} d */
    const wbTell = d => {
      if ((wbDupName[d.name] || 0) < 2) return '';
      // `st_ref` is SillyTavern's own key and is unique over there. A document Vocalis authored or
      // that was uploaded has none, so fall back to the id — never to nothing, because "nothing"
      // is exactly the state that made the two rows identical.
      const t = d.st_ref || '#' + String(d.id).slice(0, 6);
      return `<span class="small muted" title="Shown because another document has this name. This is SillyTavern's own file for it, which is what tells them apart.">${esc(t)}</span>`;
    };
    wbSet(
      wbSortDocs(kind, r.documents)
        .map(
          d => `<div class="wbrow" data-id="${esc(d.id)}">
      ${wbFaceHtml(d, 40)}
      <b>${esc(d.name)}</b>
      ${wbTell(d)}
      <span class="small muted">${d.latest + 1} revision${d.latest ? 's' : ''}</span>
      ${d.pending ? `<span class="small wbpend" title="You typed in ${d.pending} field${d.pending === 1 ? '' : 's'} of this document and have not saved yet. The text is safe on the server — open it and press Save to make it a revision, or ↺ Discard to throw it away.">(${d.pending} pending edit${d.pending === 1 ? '' : 's'})</span>` : ''}
      <div style="flex:1"></div>
      <button class="sm wbopen" data-id="${esc(d.id)}">Open</button>
      <button class="sm wbdl" data-id="${esc(d.id)}" data-name="${esc(d.name)}" title="${esc(dlTip)}">⬇</button>
      <button class="sm wbdel" data-id="${esc(d.id)}" title="Remove this document from Vocalis, with every revision of it. SillyTavern is not affected.">🗑</button>
    </div>`,
        )
        .join(''),
    ); // …and `wbSet` puts the editor back before the browser gets a turn
    wbSyncRowButtons(kind); // a repaint must not leave a stale "Open" on the open row
    wbShowDismissed(kind);
    // The roster is already usable. Warming is deliberately fire-and-forget so entering the tab
    // never waits for every book, while the first click on a finished warm is immediate.
    if (kind === 'books') void wbWarmBooks(/** @type {WbDocRow[]} */ (r.documents));
  } catch (e) {
    // 🔴 A LOCKED VAULT IS NOT AN EMPTY LIBRARY. The route answers 423 rather than [] precisely
    // so this can say so — rendering "nothing imported yet" to a man whose library is sitting
    // right there is the 4.7 list_options bug.
    if (/** @type {ErrLike} */ (e).status !== 423) {
      wbSet('<span class="warn">' + esc(/** @type {ErrLike} */ (e).message) + '</span>');
      return;
    }
    // …but the message must not OUTLIVE the lock. `pollReady` redeems the SUK and re-unlocks
    // silently a second or two after a restart (no prompt, nothing retyped), and this pane was
    // the only thing in the app that never noticed — it sat on "the vault is locked" over a
    // library that had been readable for minutes. That is what the ↻ button was really for, and
    // a button is the wrong shape for "wait a moment and look again".
    wbSet('<span class="warn">The vault is locked — unlock it to see your documents.</span>');
    if (wbLockTimer[kind]) return; // one pending retry per pane, never a pile
    wbLockTimer[kind] = setTimeout(() => {
      wbLockTimer[kind] = null;
      if (stTabNow() === kind) wbLoadLib(kind); // still looking at it? try again.
    }, 3000);
  }
}

/**
 * @param {string} kind
 * @param {File} file
 */
export async function wbImport(kind, file) {
  const fd = new FormData();
  fd.append('file', file);
  // 🔴 9.5.12 — PERSONAS KNOCK ON THEIR OWN DOOR, and the reason is §4.2 rather than tidiness.
  // The shared `/wbedit/documents` DETECTS the kind and keys a persona off our own spec marker,
  // because a persona has no field a card does not also have (§8.3) — so a persona written
  // somewhere else, carrying no marker, is refused there and always would be. `/wbedit/personas/
  // import` converts it instead, and then puts the result through the same funnel. Sending this
  // file to the generic door would 400 with "not a character card or worldbook", which is a
  // sentence about the wrong two kinds.
  const url = wbDocKind(kind) === 'persona' ? '/wbedit/personas/import' : '/wbedit/documents';
  const r = await fetch(url, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    wbSay(kind, j.error || 'import failed', true);
    return;
  }
  if (j.kind !== wbDocKind(kind))
    wbSay(kind, 'That is a ' + (j.kind === 'card' ? 'character card' : 'worldbook') + ' — it is in the other sub-tab.', true);
  await wbLoadLib(kind);
  if (j.kind === wbDocKind(kind)) {
    // 🔴 AWAITED, AND IT WAS NOT — WHICH ERASED THE MESSAGE ON THE NEXT LINE. `wbOpen` ends in
    // `wbShowCard` -> `wbPicStop` -> `wbHush`, so an unawaited open resolves a few hundred
    // milliseconds AFTER the toast is painted and clears both strips. Every import into a pane
    // with a picture lost its own report, including 9.4's "landed as revision N — the version you
    // had is still in the revision picker", which exists precisely because created / revised /
    // identical are otherwise indistinguishable without counting rows.
    await wbOpen(kind, j.id);
// Distinguish a new document, a new revision of an existing document, and an identical
// re-import, which creates no revision.
    wbSay(
      kind,
      // 🔴 9.5.12 — A PROSE IMPORT SAYS WHAT IT DID WITH THE FILE. The whole document becomes the
      // description on purpose (`persona.from_markdown`), and a description is injected into every
      // prompt over there — so the sentence that reports success is the one place he can learn
      // that the trimming is his, rather than finding a 3 KB persona in his context window later.
      j.created && j.prose
        ? 'imported "' +
            j.name +
            '" — the whole file is in the description, so trim it to what you want injected. ⬆ Upload PNG gives it a face.'
        : j.created
          ? 'imported "' + j.name + '".'
          : j.changed
            ? 'imported over "' + j.name + '" as revision ' + j.revision + ' — the version you had is still in the revision picker.'
            : '"' + j.name + '" is already exactly this — nothing was added.',
      'ok',
    );
  }
}

// The editor shows the whole, uncropped card image. The focus rect describes only the roster
// avatar crop; cropping the editor image to it would hide the rest of the picture.
//
// ── the Library's default order ──────────────────────────────────────────────
//
// Use the same sorting behavior on all three panes: name or creation date, with newest first by
// default.
//
// Sort in the browser because this roster is already a directory listing of displayed metadata;
// re-fetching to reorder would cost a round trip per click and, on a
// locked vault, would turn a reorder into a 423. The list is tens of rows, not thousands.

//: Remembered per pane. Cards and Books are used for different jobs — he browses cards by name
//: and books by what he just imported — so one shared setting would be wrong for one of them.
/** @param {string} kind */
export function wbSortKey(kind) {
  return 'vocalis-wbsort-' + kind;
}

/** @param {string} kind */
function wbSortValue(kind) {
  const sel = /** @type {HTMLSelectElement} */ (wbEl(kind, 'wbSort'));
  if (sel && sel.value) return sel.value;
  try {
    return UIS.getItem(wbSortKey(kind)) || 'new';
  } catch (e) {
    return 'new';
  }
}

//: 🔴 A COPY, NEVER IN PLACE. `r.documents` is the parsed response and sorting it in place would
//: be fine today — but this returns into a template that reads it twice, and an in-place sort of
//: a caller's array is the kind of thing that is only a bug once something else starts sharing it.
/**
 * @param {string} kind
 * @param {WbDocRow[]} docs
 * @returns {WbDocRow[]}
 */
export function wbSortDocs(kind, docs) {
  const how = wbSortValue(kind);
  /** @type {(a:WbDocRow, b:WbDocRow) => number} */
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  // `imported_at` is a float on every document (models.py). Missing reads as 0, which puts an
  // ancient row last under "newest first" rather than throwing.
  /** @type {(a:WbDocRow, b:WbDocRow) => number} */
  const byDate = (a, b) => (Number(a.imported_at) || 0) - (Number(b.imported_at) || 0);
  const cmp =
    /** @type {Record<string, (a:WbDocRow, b:WbDocRow) => number>} */ ({
      new: /** @type {(a:WbDocRow, b:WbDocRow) => number} */ ((a, b) => byDate(b, a)),
      old: byDate,
      az: byName,
      za: /** @type {(a:WbDocRow, b:WbDocRow) => number} */ ((a, b) => byName(b, a)),
    })[how] || /** @type {(a:WbDocRow, b:WbDocRow) => number} */ ((a, b) => byDate(b, a));
  // ⚠️ Ties broken by name, then id. Without a total order the browser's sort is free to shuffle
  // equal rows between renders — and two cards imported in the same sweep share `imported_at` to
  // the microsecond, so "the list reorders itself when I press ⟳" would be the visible symptom.
  return [...docs].sort((a, b) => cmp(a, b) || byName(a, b) || String(a.id).localeCompare(String(b.id)));
}

// 🔴 `wbSyncCardZoomTitle` MOVED TO `js/wb/face.js` (7.1-m11a) — it is a one-line title setter with
// no callers outside this file, and it went with the avatars because that is what it describes.
// Its callers below still say it unqualified and reach it through the shim at the bottom.

// ⚠️ The src is set to '' before it is set to the new document's, because an <img> that keeps a
// stale src paints the PREVIOUS character's face for as long as the new one takes to arrive, and
// on a document with no picture at all it would never be replaced. Reused element, reused bug.
/**
 * @param {string} kind
 * @param {WbDoc|null} doc
 */
function wbShowCard(kind, doc) {
  const wrap = /** @type {VEl} */ (wbEl(kind, 'wbCardWrap')),
    img = /** @type {HTMLImageElement} */ (wbEl(kind, 'wbCard')),
    note = wbEl(kind, 'wbCardNote');
  if (!wrap || !img) return;
  img.removeAttribute('src');
// The upload control belongs to the document kind, not whether an image already exists. Personas
// and character cards can receive their first image; world books retain their separate image
// display without upload controls. Keep the whole wrapper visible for supported document kinds.
  const canHaveFace = !!doc && doc.kind !== 'worldbook';
  if (!doc || (!doc.avatar && !canHaveFace)) {
    wrap.style.display = 'none';
    if (note) note.textContent = '';
    return;
  }
  if (!doc.avatar) {
    // Shown, but with the <img> OUT OF THE FLOW rather than merely src-less: an <img> with no
    // src and `alt=""` is a broken-image glyph in some browsers and a 220px hole in the rest.
    // The note carries the instruction, so the empty slot reads as an invitation instead of as
    // a rendering fault.
    img.style.display = 'none';
    wrap.style.display = '';
    if (note)
      note.textContent =
        kind === 'personas'
          ? 'No picture yet — ⬆ Upload PNG gives this persona a face.'
          : 'No picture yet — ⬆ Upload PNG gives this card a face.';
    // Face-picking over an image that is not there would drag a square across empty space, and
    // a rect stored against no picture is a setting with nothing to describe. `wbPicSync` hides
    // ◎ Set face for the same reason; this resets the mode in case the previous document left
    // it on, exactly as the picture path below does.
    wbPicStop(kind);
    wbPicState(kind).rect = null;
    wbPicSync(kind);
    return;
  }
  img.style.display = '';
  // 🔴 9.5.12 — THE STAMP IS WHAT MAKES A REPLACED PICTURE APPEAR, AND NO RESPONSE HEADER CAN DO
  // IT. Chrome reuses an <img> whose URL has not changed out of its per-page memory cache without
  // revalidating, so a face replaced by anything other than this tab's own POST — a ⟳ Import from
  // SillyTavern sweep pushing new bytes through `/pair/documents/<id>/avatar` — went on painting
  // the old one until a reload. Measured: with the route on `no-cache` and a plain URL, the
  // browser check for exactly that still failed. `avatar_at` is the file's (size, mtime), the
  // same pair the ETag is built from, so the URL changes when and only when the bytes do.
  img.src =
    '/wbedit/documents/' + encodeURIComponent(doc.id) + '/avatar' + (doc.avatar_at ? '?v=' + encodeURIComponent(doc.avatar_at) : '');
  wrap.style.display = '';
  // 🔴 SHRINK IT BACK. The element is reused across documents (the same bug the src note above
  // records), so a card left zoomed would open the NEXT character at full size — which reads as
  // the layout breaking rather than as a setting that persisted.
  img.classList.remove('wbfull');
  wbSyncCardZoomTitle(img);
  // Worth saying out loud: it is not decoration, it is the file that goes back to SillyTavern.
  // §8.3 — on a persona this is HIS avatar, not a card, and it carries no focus rect: the file is
  // a plain PNG under `User Avatars/` with no embedded metadata at all.
  if (note)
    note.textContent =
      kind === 'personas'
        ? 'Your persona picture, as SillyTavern stores it.'
        : doc.focus && doc.focus.w
          ? 'The card PNG. Its circle is cut at the face square below.'
          : 'The card PNG. No face square — the circle is the largest centered square.';
  // m4o — leaving face-picking on across a document change would drag a square over the wrong
  // character's picture, so the mode is reset the same way the zoom is, and for the same reason.
  wbPicStop(kind);
  wbPicState(kind).rect = doc.focus && doc.focus.w ? { x: +doc.focus.x, y: +doc.focus.y, w: +doc.focus.w } : null;
  wbPicSync(kind);
}

// ── m4o: the picture, and which square of it is the face ─────────────────────────────────────
// The crop is stored as the fractional rectangle `{x, y, w}` in `Document.focus` and passed to
// the SillyTavern fork as `data.extensions.taproom_avatar_focus`; neither side crops the source
// image. Replacing the image uses `/api/characters/edit-avatar` to preserve the current card data,
// so the extension sends only the new picture and avatar filename.
/** @param {string} kind */
export function wbPicState(kind) {
  const st = wbState(kind);
  st.pick = st.pick || { on: false, rect: null };
  return st.pick;
}

/** Redraw the square, and keep the Clear button honest about whether there is one. */
/** @param {string} kind */
export function wbPicSync(kind) {
  const st = wbState(kind),
    pick = wbPicState(kind);
  const img = /** @type {VEl} */ (wbEl(kind, 'wbCard')),
    sq = wbEl(kind, 'wbSq');
  // 🔴 9.5.12 — ◎ Set face NEEDS A PICTURE, and it is now reachable without one. The wrap is
  // shown on a pictureless card or persona so that ⬆ Upload PNG can be pressed at all
  // (`wbShowCard`), which put its two neighbors on screen with it: pressing this one would arm
  // a drag over a hidden <img> and store a rect describing a window onto nothing. Hidden rather
  // than disabled, because a disabled button SWALLOWS the press and reads as a broken control —
  // and there is nothing here for him to enable, only a picture to upload first.
  //
  // ⚠️ 9.5.13 — AND THE FOUR BUTTONS ARE ONE DECISION, WHICH IS WHY THIS DELEGATES. This function
  // used to set two of them from the STORED rect while `wbPicToggle` set a third from the MODE,
  // so any redraw during a pick (a resize, an Apply that 400s) put ◎ Set face back on screen
  // beside ✓ Apply face. `wbPicButtons` is the only place that answers "which of these is on".
  wbPicButtons(kind, pick.on);
  if (!sq || !img) return;
  const r = pick.rect;
  // 🔴 9.5.13 — VISIBLE IFF PICKING, AND THE `pick.on` HALF IS NEW. The test used to be the RECT
  // alone, which was true while `wbPicStop` was the only thing that ever hid the square. ✕ Cancel
  // restores the stored rect and then re-syncs, so under the old test it left a dimmed square and
  // its handles sitting over a picture nobody was editing — the overlay outliving the mode it
  // belongs to. Stating the invariant here is what makes every exit path correct at once.
  if (!r || !pick.on) {
    sq.style.display = 'none';
    return;
  }
  // 🔴 AGAINST THE RENDERED BOX, NOT `naturalWidth`. The card is shown at up to 220px wide and
  // the rect is fractions, so the square has to be laid out in the same coordinate space the
  // pointer reports — using the natural size would put it in roughly the right place at exactly
  // one zoom level and nowhere else.
  const w = img.clientWidth,
    h = img.clientHeight;
  const side = r.w * w;
  sq.style.display = '';
  sq.style.left = r.x * w + 'px';
  sq.style.top = r.y * h + 'px';
  sq.style.width = side + 'px';
  sq.style.height = side + 'px';
}

/** Enter or leave face-picking. Entering wraps the image; leaving puts it back exactly. */
/** @param {string} kind */
export function wbPicToggle(kind) {
  const st = wbState(kind),
    pick = wbPicState(kind);
  const img = /** @type {VEl} */ (wbEl(kind, 'wbCard'));
  if (!img || !st.doc) return;
  const btn = /** @type {VEl} */ (wbEl(kind, 'wbPicFocus'));
  if (pick.on) {
    wbPicStop(kind);
    return;
  }

  // ⚠️ SHRINK IT FIRST. The zoom (`.wbfull`) shows the PNG's own pixels, which can be taller than
  // the viewport — dragging a square on something you cannot see all of is not a control.
  img.classList.remove('wbfull');
  wbSyncCardZoomTitle(img);

  // `parentNode` is a `ParentNode`, which has no className and cannot take the <div> built below.
  // The guard above has already established this is the .wbpick element when it is non-null.
  let wrap =
    /** @type {Element} */ (img.parentNode).classList && /** @type {Element} */ (img.parentNode).classList.contains('wbpick')
      ? /** @type {HTMLDivElement} */ (img.parentNode)
      : null;
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'wbpick';
    /** @type {ParentNode} */ (img.parentNode).insertBefore(wrap, img);
    wrap.appendChild(img);
    const sq = document.createElement('div');
    sq.className = 'wbsq';
    sq.id = 'wbSq_' + kind;
    sq.style.display = 'none';
    // 🔴 9.5.13 — THE FOUR CORNER HANDLES AND THE CIRCLE GUIDE, BUILT WITH THE SQUARE. They are
    // what make this an adjustable control rather than a one-shot drag, and they are children of
    // the square so `wbPicSync` moves them for free — a handle positioned separately is a handle
    // that drifts off the corner on the first resize.
    //
    // ⚠️ THE GUIDE IS `pointer-events:none` IN CSS ON PURPOSE… AND IS STILL NAMED BY THE
    // hit-test above. It covers the whole square, so without the CSS rule it would swallow every
    // press meant for the body; and a browser that ignores the rule must not therefore break
    // move, which is why `wbsqc` counts as the square in `pointerdown`. Two independent reasons
    // the drag keeps working, which is the point.
    const guide = document.createElement('div');
    guide.className = 'wbsqc';
    sq.appendChild(guide);
    for (const c of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('div');
      h.className = 'wbh wbh-' + c;
      sq.appendChild(h);
    }
    wrap.appendChild(sq);
  }
  wrap.classList.add('wbpicking');
  pick.on = true;
// Set face arms the picker; Apply face performs the write. Pointer movement only adjusts the
// selection and must not save it.
  wbPicButtons(kind, true);
  // 🔴 AND IT OPENS ON A SQUARE HE CAN ALREADY GRAB, WHICH IS THE OTHER HALF OF THE COMPLAINT.
  // *"it's hard to get the oval exactly centered… in one shot."* Starting empty made the FIRST
  // drag decide everything, so the centered square — the thing a card with no rect already gets,
  // and the answer nine times out of ten — was the one result a freehand drag could not produce.
  // Now it is where the control starts, and every gesture from there is an adjustment.
  const f = st.doc.focus;
  pick.rect = f && f.w ? { x: +f.x, y: +f.y, w: +f.w } : wbPicCentered(kind);
  wbPicSync(kind);
  wbSay(kind, 'Drag the square to move it, its corners to resize — then ✓ Apply face. Nothing is written yet.', 'busy');
  wbPicBind(kind);
}

/** The largest centered square of the picture as it is rendered, in the rect's own fractions.
 *
 * ⚠️ MEASURED OFF THE RENDERED BOX, LIKE EVERYTHING ELSE IN THIS PICKER. `wbFitFace` computes the
 * same square off `naturalWidth`/`naturalHeight`; the two agree because the box preserves aspect,
 * and using the rendered one here keeps every number in this file in one coordinate space.
 * @param {string} kind
 */
function wbPicCentered(kind) {
  const img = /** @type {VEl} */ (wbEl(kind, 'wbCard'));
  const W = img ? img.clientWidth : 0,
    H = img ? img.clientHeight : 0;
  if (!W || !H) return null;
  const s = Math.min(W, H);
  return { x: (W - s) / 2 / W, y: (H - s) / 2 / H, w: s / W };
}

/** Which of the four picker buttons are on screen. One place, because they are a mode.
 *
 * ⚠️ HIDDEN, NEVER DISABLED — the pane's standing rule (`wbPicSync`, `◎ Set face` on a
 * pictureless card): a disabled button swallows the press and reads as broken.
 * @param {string} kind
 * @param {boolean} picking
 */
function wbPicButtons(kind, picking) {
  const st = wbState(kind);
  /** @param {string} id @param {boolean} on */
  const show = (id, on) => {
    const el = /** @type {VEl} */ (wbEl(kind, id));
    if (el) el.style.display = on ? '' : 'none';
  };
  const hasPicture = !!(st.doc && st.doc.avatar);
  show('wbPicFocus', hasPicture && !picking);
  show('wbPicApply', picking);
  show('wbPicCancel', picking);
  // Clear face is about the STORED rect, so it stays out of the way while an unapplied one is
  // being dragged — pressing it mid-pick would write, which is the thing Apply now owns.
  show('wbPicFocusClear', !picking && !!(st.doc && st.doc.focus && st.doc.focus.w));
}

/** ✓ Apply face — the only thing in this picker that writes. */
/** @param {string} kind */
export async function wbPicApply(kind) {
  const st = wbState(kind),
    pick = wbPicState(kind);
  if (!pick.on || !st.doc) return;
  if (!pick.rect) {
    wbSay(kind, 'no square to apply — drag one over the picture first.', true);
    return;
  }
  try {
    // The server clamps and validates — the rect ends up in his card and in a SillyTavern
    // thumbnail URL, so the browser is not the authority on whether it is sane.
    const doc = await jpost('/wbedit/documents/' + encodeURIComponent(st.doc.id) + '/focus', {
      focus: pick.rect,
    });
    st.doc.focus = doc.focus;
    wbPicStop(kind);
    await wbLoadLib(kind); // the roster's circle is cut at this rect
    wbSay(kind, 'face set — press Save to SillyTavern to send it', 'ok');
  } catch (err) {
    const ex = /** @type {ErrLike} */ (err);
    // 🔴 THE PICKER STAYS OPEN ON A REFUSAL, holding the square he built. Closing it would make
    // him re-do the whole adjustment to retry, which is the one-shot behavior coming back in
    // through the error path.
    wbSay(kind, (ex.body && /** @type {string} */ (ex.body.error)) || 'could not set the face', true);
  }
}

/** ✕ Cancel — leave the stored rect exactly as it was. */
/** @param {string} kind */
export function wbPicCancel(kind) {
  const st = wbState(kind),
    pick = wbPicState(kind);
  const f = st.doc && st.doc.focus;
  pick.rect = f && f.w ? { x: +f.x, y: +f.y, w: +f.w } : null;
  wbPicStop(kind);
  wbPicSync(kind);
}

/** @param {string} kind */
function wbPicStop(kind) {
  const pick = wbPicState(kind),
    img = wbEl(kind, 'wbCard');
  pick.on = false;
  wbPicButtons(kind, false);
  if (img && img.parentNode && /** @type {Element} */ (img.parentNode).classList.contains('wbpick')) {
    /** @type {Element} */ (img.parentNode).classList.remove('wbpicking');
  }
  const sq = /** @type {VEl} */ (wbEl(kind, 'wbSq'));
  if (sq) sq.style.display = 'none';
  wbHush(kind);
}

/**
 * The picture's rendered box — the one coordinate space every number in the picker lives in.
 * @typedef {object} WbPicGeo
 * @property {DOMRect} b - the box itself, for turning client coordinates into local ones
 * @property {number} W - rendered width in CSS pixels
 * @property {number} H - rendered height
 * @property {number} cap - `min(W, H)`, the largest square the picture can hold
 */

/** Handle crop gestures on the shared picker wrapper: move the square, resize from a corner, or draw a replacement on the image. Only `wbPicApply` writes the crop. Keep the selection square because the stored format is a width fraction with no height field.
 * @param {string} kind
 */
function wbPicBind(kind) {
  const img0 = /** @type {VEl} */ (wbEl(kind, 'wbCard'));
  const wrap = /** @type {VEl|null} */ (
    img0 && img0.parentNode && /** @type {Element} */ (img0.parentNode).classList.contains('wbpick') ? img0.parentNode : null
  );
  if (!wrap || wrap._wbPicBound) return;
  wrap._wbPicBound = true;

  //: Small enough to be a deliberate choice, big enough that the four handles do not overlap
  //: into one unusable blob. Below this a drag is treated as a mis-click rather than as a rect.
  const MIN_PX = 24;

  /** The picture's rendered box, which is the coordinate space every number here lives in.
   *  🔴 RE-READ ON EVERY GESTURE, NEVER CACHED AT BIND TIME: this element is reused across
   *  documents and the pane reflows, so a box measured once is wrong for every later picture. */
  const geo = () => {
    const img = /** @type {VEl} */ (wbEl(kind, 'wbCard'));
    const b = img.getBoundingClientRect();
    return { b, W: b.width, H: b.height, cap: Math.min(b.width, b.height) };
  };

  /** Rendered pixels -> the stored fractions, clamped into the picture on the way.
   *  ⚠️ THE CLAMP IS HERE AND NOWHERE ELSE. Three gestures produce rects; a clamp per gesture is
   *  three chances to get it wrong, and the failure — a rect describing a window partly off the
   *  picture — shows the background through the circle rather than throwing. */
  /** @param {number} left @param {number} top @param {number} side @param {WbPicGeo} g */
  const put = (left, top, side, g) => {
    const s = Math.max(Math.min(MIN_PX, g.cap), Math.min(side, g.cap));
    const x = Math.max(0, Math.min(left, g.W - s));
    const y = Math.max(0, Math.min(top, g.H - s));
    wbPicState(kind).rect = { x: x / g.W, y: y / g.H, w: s / g.W };
    wbPicSync(kind);
  };

  /** The stored fractions -> rendered pixels. */
  /** @param {WbPicGeo} g */
  const at = g => {
    const r = wbPicState(kind).rect;
    return r ? { left: r.x * g.W, top: r.y * g.H, side: r.w * g.W } : null;
  };

  /** @type {{mode:string, corner:string, ox:number, oy:number, left:number, top:number, side:number}|null} */
  let drag = null;

  /** @param {PointerEvent} e @param {WbPicGeo} g */
  const point = (e, g) => ({
    x: Math.min(Math.max(e.clientX - g.b.left, 0), g.W),
    y: Math.min(Math.max(e.clientY - g.b.top, 0), g.H),
  });

  wrap.addEventListener('pointerdown', e => {
    if (!wbPicState(kind).on) return;
    const t = /** @type {Element|null} */ (e.target);
    if (!t || !t.classList) return;
    // A press on the dimmed surround is the box-shadow of the square, not the picture — it
    // belongs to no gesture, and treating it as a redraw would erase the rect on a stray click
    // outside the picture entirely.
    const onHandle = t.classList.contains('wbh');
    const onSquare = t.classList.contains('wbsq') || t.classList.contains('wbsqc');
    const onImage = t.tagName === 'IMG';
    if (!onHandle && !onSquare && !onImage) return;
    e.preventDefault(); // stop the browser's own image-drag
    const g = geo();
    const p = point(e, g);
    const cur = at(g);
    // ⚠️ CAPTURE IS BEST-EFFORT. `setPointerCapture` throws `NotFoundError` for a pointer id that
    // is not currently active — which a synthetic event always is, so an uncaught call here takes
    // the whole handler out and the drag silently never starts. Capture is a nicety (it keeps the
    // drag alive past the edge of the picture); every gesture works without it.
    try {
      wrap.setPointerCapture(e.pointerId);
    } catch (err) {
      /* not a live pointer */
    }
    if (onHandle && cur) {
      drag = { mode: 'resize', corner: (t.className.match(/wbh-(\w+)/) || [, 'se'])[1], ox: 0, oy: 0, ...cur };
    } else if (onSquare && cur) {
      // The grab offset, so the square does not jump its own top-left under the pointer.
      drag = { mode: 'move', corner: '', ox: p.x - cur.left, oy: p.y - cur.top, ...cur };
    } else {
      drag = { mode: 'draw', corner: '', ox: p.x, oy: p.y, left: p.x, top: p.y, side: 0 };
    }
  });

  wrap.addEventListener('pointermove', e => {
    if (!wbPicState(kind).on || !drag) return;
    const g = geo();
    const p = point(e, g);
    if (drag.mode === 'move') {
      put(p.x - drag.ox, p.y - drag.oy, drag.side, g);
      return;
    }
    if (drag.mode === 'draw') {
      // The old gesture, unchanged: a square anchored at the press, sized by the smaller axis so
      // it never runs ahead of the pointer in the direction he is not moving.
      const side = Math.min(Math.abs(p.x - drag.ox), Math.abs(p.y - drag.oy));
      if (side < MIN_PX) return; // a click on the picture is not a request to erase the square
      put(p.x < drag.ox ? drag.ox - side : drag.ox, p.y < drag.oy ? drag.oy - side : drag.oy, side, g);
      return;
    }
    // Resize. The OPPOSITE corner is the anchor and stays put; the side follows the axis he is
    // moving furthest along, which is what makes a mostly-horizontal drag feel like it is
    // tracking the pointer rather than lagging it.
    const c = drag.corner;
    const ax = c === 'nw' || c === 'sw' ? drag.left + drag.side : drag.left;
    const ay = c === 'nw' || c === 'ne' ? drag.top + drag.side : drag.top;
    const side = Math.max(Math.abs(p.x - ax), Math.abs(p.y - ay));
    put(p.x < ax ? ax - side : ax, p.y < ay ? ay - side : ay, side, g);
  });

  /** 🔴 THE RELEASE ENDS THE GESTURE AND NOTHING ELSE. This is where the POST used to be, and
   *  removing it IS the feature: the square survives the release, so the next drag adjusts it
   *  instead of replacing it. `✓ Apply face` writes. */
  const release = () => {
    drag = null;
  };
  wrap.addEventListener('pointerup', release);
  wrap.addEventListener('pointercancel', release);
}

// §8.2b — what he deleted stays deleted, and says so.
//
// 🔴 THE STATE HAS TO BE VISIBLE OR IT READS AS A BUG. He deletes a character, presses
// ⟳ Import from SillyTavern, and nothing comes back — without this line there is no way to tell
// "Vocalis is honoring my delete" from "the import is broken". The restore is one click.
/** @param {string} kind */
async function wbShowDismissed(kind) {
  const box = /** @type {VEl} */ (wbEl(kind, 'wbLib'));
  if (!box) return;
  /** @type {string[]} */
  let refs = [];
  try {
    refs = (await jget('/wbedit/dismissed')).refs || [];
  } catch (e) {
    return;
  }
  let bar = /** @type {HTMLDivElement} */ (/** @type {unknown} */ (wbEl(kind, 'wbDismissed'))); // see pg/playground.js for why the cast is doubled
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'wbDismissed_' + kind;
    bar.className = 'small muted';
    bar.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid var(--line)';
    /** @type {ParentNode} */ (box.parentNode).insertBefore(bar, box.nextSibling);
  }
  if (!refs.length) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
// Keep each deleted document as its own row so it can be identified and restored individually.
  //
  // ⚠️ THE DOCUMENT ITSELF IS GONE — every revision of it, irreversibly (the delete confirm says
  // so). What survives is the `st_ref`: SillyTavern's own key, which is the avatar filename for a
  // card and the book name for a worldbook. So these rows carry no face and no revision count,
  // because there is nothing left to count. Rendering a fake "1 revision" beside them would
  // promise history that does not exist.
  //
  // 🔴 UNDELETE RUNS THE IMPORT ITSELF (9.7.1 — see `wbUndelete`). It used to mean only "stop
  // declining this push", which left a button labeled Undelete removing the row and restoring
  // nothing. Restoring the DATA is still SillyTavern's job; what changed is that the button now
  // asks it, and puts the row back if the answer does not arrive.
  bar.innerHTML =
    `<div class="small" style="margin-bottom:4px;opacity:.75">` +
    `Deleted here. <b>Undelete</b> brings ${refs.length === 1 ? 'it' : 'them'} back from SillyTavern — ` +
    `it needs a SillyTavern tab open with the Vocalis extension paired.` +
    `</div>` +
    refs
      .map(
        r =>
          `<div class="wbrow wbgone" data-ref="${esc(r)}">` +
          `<b>${esc(r)}</b>` +
          `<span class="small">[deleted]</span>` +
          `<div style="flex:1"></div>` +
          `<button class="sm wbundel" data-ref="${esc(r)}" title="Bring this one back: Vocalis ` +
          `stops declining it and imports it from SillyTavern in the same press. Needs a ` +
          `SillyTavern tab open with the Vocalis extension paired.&#10;&#10;What comes back is ` +
          `SillyTavern's copy — any revisions you had made here went when you deleted it. If it ` +
          `does not arrive, this row stays exactly where it is so you can try again.">` +
          `Undelete</button>` +
// Permanently deleting this row removes the reversible decline state, not document data: the
// document and all revisions were already deleted. The row is
          // SillyTavern's own key and a standing instruction to decline it. So "permanently"
          // cannot mean "destroy more"; it means the decline stops being reversible and the row
          // leaves the bin. Dropping the ref outright would do the OPPOSITE of what the label
          // says — the next ⟳ Import would bring the book straight back — which is why the store
          // moves it to a second list rather than forgetting it.
          `<button class="sm danger wbpurge" data-ref="${esc(r)}" title="Take this out of the bin ` +
          `and keep declining it for ever. Nothing more is deleted — the document itself went when ` +
          `you deleted it — but Undelete will no longer be offered for it.">✕</button></div>`,
      )
      .join('');
  bar.querySelectorAll('.wbundel').forEach(b => b.addEventListener('click', () => wbUndelete(kind, /** @type {HTMLElement} */ (b))));
  bar.querySelectorAll('.wbpurge').forEach(b =>
    b.addEventListener('click', async () => {
      const ref = /** @type {string} */ (/** @type {HTMLElement} */ (b).dataset.ref);
      // ⚠️ THE CONFIRM SAYS WHAT IS AND IS NOT ABOUT TO HAPPEN, in that order. A dialog that only
      // says "this cannot be undone" over a row labeled [deleted] reads as "your document is
      // about to be destroyed", and it already was — the one thing actually at stake is the
      // Undelete button, so that is the sentence.
      const ok = await modal(
        'Delete permanently?',
        `<b>${esc(ref)}</b> stays declined for ever and leaves this list.<br><br>` +
          `Nothing further is deleted — the document and its revisions went when you deleted it. ` +
          `What you lose is <b>Undelete</b>: ⟳ Import from SillyTavern will never bring this one back.`,
        [
          { label: 'Cancel', value: 0 },
          { label: 'Delete permanently', class: 'danger', value: 1 },
        ],
      );
      if (!ok) return;
      await jpost('/wbedit/dismissed/' + encodeURIComponent(ref) + '/purge', {});
      wbSay(kind, 'deleted permanently — it will not come back on an import');
      wbLoadLib(kind);
    }),
  );
}

// ── Undelete, which now UNDELETES (9.7.1) ────────────────────────────────────
//
// 🔴 THE BUTTON DID NOT DO WHAT IT SAID, AND THE WAY IT FAILED DESTROYED THE LAST RECORD OF WHAT
// WAS DELETED. Removing a dismissal entry without re-importing the document made it vanish from
// both the bin and the library.
//
// It was doing exactly what it was built to do: `DELETE /wbedit/dismissed/<ref>` drops one line
// from `dismissed.json` and fetches nothing, because the DATA lives in SillyTavern and only the
// ⟳ sweep can pull it. The row then correctly left the bin — the ref was no longer declined — and
// the Library correctly showed nothing, because there was no document. Two correct behaviors, and
// between them a user who pressed a button labeled `Undelete` and watched the document stop
// existing anywhere on screen.
//
// 🔴 WHAT MAKES IT SEVERE IS NOT THE MISSING IMPORT, IT IS THE VANISHING ROW. The document was
// already gone at the delete; that is by design and the confirm says so. But the bin row held the
// one surviving fact — WHICH card it had been — and the press consumed it. Close the tab there and
// nothing anywhere knows what to re-import. A wrong click cost a piece of state that no later
// action could reconstruct, which is the definition of the thing a recycle bin exists to prevent.
//
// ✅ SO THE PRESS NOW RUNS THE WHOLE GESTURE: un-decline, import, and then CHECK — and if the
// document did not come back, put the ref straight back in the bin so the row and its Undelete are
// exactly where they were. Nothing is consumed until the thing it stands for exists again.
//
// ⚠️ THE CHECK ASKS THE LIBRARY, NOT THE SWEEP'S TALLY. "imported 12 characters" is a count of what
// SillyTavern sent, and the honest question here is the narrow one — is THIS `st_ref` a document
// now? A ref whose card he had also deleted inside SillyTavern imports zero of itself while the
// sweep reports a perfectly successful run, and trusting the tally would eat the row on exactly
// the case where he most needs to still see it.
/**
 * @param {string} kind
 * @param {HTMLElement} btn - the pressed `Undelete`, whose row is disabled for the duration
 */
async function wbUndelete(kind, btn) {
  const ref = /** @type {string} */ (btn.dataset.ref);
  const row = btn.closest('.wbrow');
  // ⚠️ BOTH BUTTONS, NOT JUST THIS ONE: ✕ Delete permanently sits beside it and would otherwise
  // stay live over a row whose ref is mid-flight — a purge landing between the restore and the
  // rollback writes the ref to `dismissed_forever` and takes Undelete away for good.
  //
  // ⚠️ THE CAST IS ITS OWN STATEMENT BECAUSE PRETTIER RETARGETS AN INLINE ONE. Written as
  // `.forEach(x => /** @type {HTMLButtonElement} */ (x).disabled = on)` the formatter moves the
  // parens to wrap the whole ASSIGNMENT, so the annotation asserts that a boolean is a button and
  // `tsc` says so (TS2352). Same trap `project_8_3_2_prettier` records; the detector worked.
  const pressable = /** @type {NodeListOf<HTMLButtonElement>|never[]} */ (row ? row.querySelectorAll('button') : []);
  /** @param {boolean} on */
  const busy = on => {
    pressable.forEach(x => {
      x.disabled = on;
    });
    btn.textContent = on ? 'Undeleting…' : 'Undelete';
  };
  busy(true);
  try {
    await jdel('/wbedit/dismissed/' + encodeURIComponent(ref));
  } catch (e) {
    busy(false);
    const why = /** @type {ErrLike} */ (e).message;
    wbSay(kind, 'could not undelete that — ' + (why || 'the store said no'), true);
    return;
  }
  wbSay(kind, 'undeleted — asking SillyTavern for it…', 'busy');

  // 🔴 THROUGH THE REGISTRY (see `runWbAction`): importing `st.js` from here closes a cycle.
  // `undefined` back means nothing owns the name, which cannot happen on a page that has an import
  // button — but an un-rolled-back row would be the same silent loss this function exists to fix,
  // so it is handled rather than assumed away.
  const sweep = await new Promise(resolve => {
    if (runWbAction('wbStSweep', kind, resolve) === undefined) resolve({ unasked: true });
  });

  let back = false;
  try {
    // No `?kind=` — the sweep brings books, cards and personas in one pass and the bin is shared
    // across all three panes, so the narrow question is only ever "does this ref have a document".
    back = ((await jget('/wbedit/documents')).documents || []).some(
      (/** @type {{st_ref?: string}} */ d) => (d.st_ref || '').trim() === ref,
    );
  } catch (e) {
    // ⚠️ AN UNREADABLE LIBRARY IS NOT AN ABSENT DOCUMENT — the `list_options` rule, and here it
    // decides whether to write. Rolling back on a failed READ would re-dismiss a card that may have
    // landed perfectly well, so this leaves the ref restored and says why. The cost of guessing
    // wrong in this direction is one extra ⟳ Import; in the other it is a resurrected delete.
    wbSay(kind, 'undeleted, but Vocalis could not read the Library back — press ⟳ Import from SillyTavern to check.', true);
    return;
  }

  if (back) {
    wbSay(kind, `“${ref}” is back — imported from SillyTavern.`, 'ok');
  } else {
    // 🔴 THE ROLLBACK. Everything is exactly as it was before the press, INCLUDING the row, so a
    // second attempt (with the tab open this time) is the same one click.
    let kept = true;
    try {
      await jpost('/wbedit/dismissed', { ref });
    } catch (e) {
      kept = false;
    }
    const why = sweep.canceled
      ? 'the import was canceled'
      : sweep.unasked
        ? 'the import could not be started'
        : sweep.expired || sweep.silent
          ? 'SillyTavern never answered — is a tab open with the Vocalis extension paired?'
          : 'SillyTavern did not send it — is it still there, under this name?';
    wbSay(
      kind,
      kept
        ? `“${ref}” did not come back: ${why}. It is back in the list below, so you can try again.`
        : `“${ref}” did not come back: ${why}.`,
      true,
    );
  }
  await wbLoadLib(kind);
}

// ── §6.1.2a the editor opens INLINE, under the row that was clicked ──────────
//
// Open the editor inline below the clicked library row so it appears in the current viewport.
//
// 🔴 THE PANE IS MOVED, NEVER RE-RENDERED. There is one editor and one open document, so moving
// the existing node keeps every field's text, scroll position, dirty state and event handler.
// Re-rendering it into the row would throw away an in-progress hand edit.
//
// 🔴 AND THE NODE IS CACHED, because parking it among the rows puts it inside the element
// `wbLoadLib` overwrites. After that overwrite the node is detached, and `getElementById` cannot
// find a detached node — so every later `wbEl(kind,'wbEditor')` would answer null. This cache is
// the only reference that survives, exactly as `scPlace()` keeps the one <audio>.
/** @type {Record<string, VEl>} */
export const WB_PANE = {};
/** @type {Record<string, {parent: ParentNode|null, next: ChildNode|null}>} */
const WB_HOME = {};

/** @param {string} kind */
function wbPane(kind) {
  // ⚠️ ASSERTED HERE, AND THE MARKUP IS THE ARGUMENT — NOT INHERITANCE. `wbEl` became honestly
  // nullable at m10, and this is the one place a `wbEl` result is CACHED, so the cast belongs
  // at the memo rather than at the six call sites. It is true: `wbEditor_cards`,
  // `wbEditor_books` and `wbEditor_personas` are all static in index.html, so every valid
  // `kind` resolves. An invalid one would now cache null forever, which is why this says
  // WHICH ids justify it rather than just silencing the checker.
  return WB_PANE[kind] || (WB_PANE[kind] = /** @type {VEl} */ (wbEl(kind, 'wbEditor')));
}

//: Where the pane lives when nothing is open. Captured once, BEFORE the first move.
/** @param {string} kind */
function wbHome(kind) {
  const pane = wbPane(kind);
  if (!WB_HOME[kind]) WB_HOME[kind] = { parent: pane.parentNode, next: pane.nextSibling };
  return WB_HOME[kind];
}

/**
 * @param {string} kind
 * @param {VEl} [pane]
 */
function wbPlaceEditor(kind, pane) {
  pane = pane || wbPane(kind);
  const home = wbHome(kind);
  const st = wbState(kind);
  const lib = /** @type {VEl} */ (wbEl(kind, 'wbLib'));
  // No open document, or its row is not on screen (a worldbook filter can hide it) — the pane
  // goes back where it started rather than vanishing or clinging to an unrelated row.
  const row = st.openId && lib ? lib.querySelector('.wbrow[data-id="' + CSS.escape(st.openId) + '"]') : null;
  if (!row) {
    if (pane.parentNode !== home.parent) /** @type {ParentNode} */ (home.parent).insertBefore(pane, home.next);
    return;
  }
  let slot = row.nextElementSibling;
  if (!slot || !slot.classList.contains('wbslot')) {
    slot = document.createElement('div');
    slot.className = 'wbslot';
    row.after(slot);
  }
  if (pane.parentNode !== slot) slot.appendChild(pane);
}

// World Books are warmed as soon as their roster is available. The hidden nodes are moved into
// the live editor on click, so a large book pays its DOM construction cost in the background.
/** @type {Record<string, {doc: WbDoc, fields: any, rev: any, host: HTMLDivElement}>} */
const WB_BOOK_WARM = {};
let wbBookWarmGeneration = 0;

/** @returns {HTMLDivElement} */
function wbBookWarmRoot() {
  let root = /** @type {HTMLDivElement|null} */ (document.getElementById('wbWarmBooks'));
  if (root) return root;
  root = document.createElement('div');
  root.id = 'wbWarmBooks';
  root.hidden = true;
  document.body.appendChild(root);
  return root;
}

/** @param {string} kind */
function wbClearBookWarm(kind) {
  if (kind !== 'books') return;
  wbBookWarmGeneration++;
  Object.keys(WB_BOOK_WARM).forEach(k => delete WB_BOOK_WARM[k]);
  const root = document.getElementById('wbWarmBooks');
  if (root) root.replaceChildren();
}

/**
 * Pre-parse the field list in a hidden container. This intentionally mirrors the live editor's
 * markup: moving these nodes later avoids both template parsing and the large innerHTML repaint.
 * @param {string} kind
 * @param {WbField[]} fields
 * @param {any} content
 * @returns {string}
 */
function wbWarmFieldsHtml(kind, fields, content) {
  let lastGroup = '';
  return (
    fields
      .map((f, i) => {
        const text = wbGetAt(content, f.locator);
        const x = /(?:^|·\s*)X-/i.test(f.label);
        const m = wbMode(f.mode);
        const head = f.group && f.group !== lastGroup ? `<h4 class="wbgroup">${esc(f.group)}</h4>` : '';
        lastGroup = f.group || '';
        const pd = f.pass_default !== false;
        const isE = !!f.entry;
        const hd = isE ? 'div' : 'label';
        const inert = !!f.inert;
        const isEmpty = !!f.empty;
        const emptyTip =
          'This field is empty. Type into it and press Save to give the card one — it is written into the document exactly like any other field, and goes to SillyTavern with the next ⬆ Save to SillyTavern. It cannot be included in a pass while it is empty: there would be nothing to rewrite, and the model would invent something.';
        return `${head}<div class="wbfield${x ? ' wbx' : ''}${m ? ' m' + f.mode : ''}${inert ? ' wbinert' : ''}${isEmpty ? ' wbempty' : ''}" data-i="${i}" data-mode="${esc(f.mode || '')}">
      <${hd} class="wbhead">
        <input type="checkbox" class="wbtick" data-i="${i}"${pd ? ' checked' : ''} title="${esc(isEmpty ? emptyTip : WB_TICK_TIP)}"${isEmpty ? ' disabled' : ''}>
        ${isE ? '<span class="wbcar" aria-hidden="true"></span>' : ''}
        ${m ? `<span class="wbdot m${f.mode}" title="${esc(m.tip)}">${m.glyph}</span>` : ''}
        <b>${esc(f.label)}</b>
        ${inert ? '<span class="wbinerttag" title="This entry has no keywords and is not always-injected, so SillyTavern stores it, shows it, and never fires it. Give it a keyword, or set it to always injected.">no keywords — never fires</span>' : ''}
        ${isEmpty ? `<span class="wbemptytag" title="${esc(emptyTip)}">empty — type to add it</span>` : ''}
        <span class="small muted" title="${esc(isEmpty ? emptyTip : WB_TICK_TIP)}">${isEmpty ? 'not on this card yet' : `${f.chars} chars`}${x ? ' · X — shown collapsed by courtesy, not withheld' : ''}</span>
      </${hd}>
      <textarea class="wbtext" data-i="${i}"${isEmpty ? ' placeholder="Empty. Type here and press Save to add this field to the card."' : ''} rows="${Math.min(18, Math.max(3, Math.ceil(text.length / 90)))}">${esc(text)}</textarea>
      ${
        f.entry
          ? `<div class="wbkeys"><div class="wbsetbody wbkeysbody"></div></div>
      <div class="wbset"><button type="button" class="wbsetog" data-i="${i}">⚙ settings</button><div class="wbsetbody" hidden></div></div>`
          : ''
      }
    </div>`;
      })
      .join('') ||
    (kind === 'books'
      ? '<span class="muted">This World Book has no entries yet. Press ✚ Add entry, above, to make one.</span>'
      : '<span class="muted">This document has no editable fields.</span>')
  );
}

/** @param {string} id @returns {{doc:WbDoc, fields:any, rev:any, host:HTMLDivElement}|null} */
function wbTakeWarmBook(id) {
  const cached = WB_BOOK_WARM[id];
  if (!cached) return null;
  delete WB_BOOK_WARM[id];
  return cached;
}

/** @param {{host:HTMLDivElement}} cached */
function wbUseWarmBook(cached) {
  const fields = /** @type {VEl} */ (wbEl('books', 'wbFields'));
  fields.replaceChildren(...Array.from(cached.host.childNodes));
  cached.host.remove();
}

/** @param {WbDocRow[]} rows */
async function wbWarmBooks(rows) {
  const generation = wbBookWarmGeneration;
  const queue = rows.slice();
  const worker = async () => {
    while (queue.length) {
      const row = queue.shift();
      if (!row || generation !== wbBookWarmGeneration) return;
      try {
        const doc = /** @type {WbDoc} */ (await jget('/wbedit/documents/' + encodeURIComponent(row.id)));
        const n = doc.latest;
        const [fields, rev] = await Promise.all([
          jget('/wbedit/documents/' + encodeURIComponent(row.id) + '/fields?revision=' + n),
          jget('/wbedit/documents/' + encodeURIComponent(row.id) + '/revision/' + n),
        ]);
        if (generation !== wbBookWarmGeneration) return;
        const host = document.createElement('div');
        host.className = 'wbwarmbook';
        host.dataset.id = row.id;
        host.dataset.revision = String(n);
        host.innerHTML = wbWarmFieldsHtml('books', fields.fields || [], rev.content);
        wbBookWarmRoot().appendChild(host);
        WB_BOOK_WARM[row.id] = { doc, fields, rev, host };
        // Yield so a large library does not monopolize the main thread while it warms.
        await new Promise(resolve => setTimeout(resolve, 0));
      } catch (e) {
        // A failed warm falls back to the normal open path.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
}

// ── the Editor pane ──────────────────────────────────────────────────────
// m4n — ` [4-Aug-2026 5:02 PM]` for a revision's epoch-seconds timestamp, or '' when we have none.
//
// 🔴 STORED UTC, RENDERED LOCAL, AND THE CONVERSION HAPPENS HERE AND NOWHERE ELSE. `created_at` is
// epoch seconds out of the vault — no timezone in it, none needed — and the browser is the only
// party that knows what local time means to the user. A server-side format would bake the server's
// timezone into revision history.
//
// ⚠️ `toLocale*` WITH AN EXPLICIT SHAPE, not the locale default. `en-GB` gives `4 Aug 2026` and
// `en-US` gives `Aug 4, 2026`; the required `4-Aug-2026` shape is assembled from the parts rather
// than hoped for from a locale string.
// 📌 `wbWhen` MOVED TO `js/wb/fmt.js` (7.1-m9) — the prompt picker and the document
// picker both use it and neither owns it. Reached below through the shim.

// `opts.scrollToRow: false` — m5e / §9a.24. The caller has its own destination and will move the
// viewport itself, so the row scroll below must not run. 🔴 It is a SUPPRESSION rather than a
// "scroll afterward", because `wbScrollToRow` animates (`behavior:'smooth'`): an instant scroll
// issued on top of a running smooth scroll only displaces its starting point, and Chrome carries
// on easing to the original target. That is the whole bug — see `wbAddEntry`.
// ── §9a.11 / 7.5.20 — which world book this character uses ────────────────────────────────────
//
// The view is forward-only: show which book a character uses. The reverse view, which characters
// use the current book, remains outside this pane's scope.
//
// 🔴 THE NAME COMES FROM THE SERVER, RESOLVED FROM `world_id`, NOT FROM `world_ref`. §8.2 holds
// the link as an id so a rename cannot break it; `world_ref` is the name the CARD says, frozen on
// import day. Printing that would show the old name after he renames a book here, while the SEND
// resolves the current one — the pane disagreeing with what SillyTavern is about to receive.
//
// ⚠️ THREE STATES, AND THE MIDDLE ONE IS THE INFORMATIVE ONE. A card can name a book Vocalis does
// not hold (import order, or a book he keeps only in SillyTavern). That is not an error and the
// name is still the truth — but it is flagged, because "Vocalis has this book" and "the card
// mentions this book" are different facts and only the first one backs the Cards-pane filter.
//
// 🔴 9.7.3 — IT IS A DROPDOWN NOW. The dropdown can select a book in Vocalis or clear the
// association.
//
// 🔴 THE OPTIONS ARE FETCHED ON EVERY OPEN, exactly as `wbLoadBookFilter` refetches for the
// roster's filter, and for the same reason: he can import or rename a book on the World Books
// sub-tab and come straight back here. A list built once at boot goes stale silently, and a
// dropdown missing the book he just made reads as the book not existing.
//
// ⚠️ THE THIRD STATE SURVIVES AS AN OPTION RATHER THAN A CAPTION. A card naming a book we do not
// hold has no id to select, so it gets an option of its own carrying the card's own name and the
// flag — selected, so the control shows the truth instead of silently reading "— no world book —"
// over a card that plainly has one.
//
// 🔴 `WORLD_REF` CANNOT COLLIDE WITH A DOCUMENT ID, and that is a fact about `models.new_id`
// rather than a hope: an id is `secrets.token_hex(8)`, so it is sixteen characters of `[0-9a-f]`
// and can hold no space. The change handler refuses this value outright — it names a STATE, not
// a book, and posting it would be posting a name where §8.2 requires an identity.
export const WORLD_REF = 'not in vocalis';

/**
 * @param {string} kind
 * @param {WbDoc|null} doc
 * @param {number} [seq] - `wbOpen`'s generation token. This function FETCHES, so it can land
 *   after the user has clicked another card; without the token the later-resolving render wins
 *   and the header ends up describing a document that is no longer on screen. The same 5.1
 *   hazard `wbOpen`'s own three fetches carry, arriving through a fourth.
 */
async function wbShowWorld(kind, doc, seq) {
  const wrap = document.getElementById('wbWorldWrap_cards');
  const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('wbWorldPick_cards'));
  // Books and personas have no such link. A persona's lorebook is a different thing living in
  // SillyTavern's own settings (§8.3), and inventing a row for it here would be a claim.
  if (!wrap || !sel) return;
  if (wbDocKind(kind) !== 'card' || !doc) {
    wrap.style.display = 'none';
    return;
  }
  // 🔴 EMPTIED AND DISABLED BEFORE THE FETCH, AND THIS IS A CORRECTNESS FIX RATHER THAN A
  // SPINNER. `wbOpen` calls this unawaited, so between opening card B and the books list landing
  // the control still held card A's options with A's book selected — a header asserting the wrong
  // character's association, and ACCEPTING A CLICK on it. The change handler reads `st.doc.id`,
  // which is already B, so one press in that window would have written A's book onto B. The
  // browser spec caught it as three stale reads; the bug it was reading is worse than the reads.
  sel.disabled = true;
  sel.innerHTML = '<option value="">…</option>';
  wrap.style.display = 'inline-flex';
  /** @type {{id:string, name:string}[]} */
  let books = [];
  try {
    books = (await jget('/wbedit/documents?kind=worldbook')).documents;
  } catch (e) {
    // 🔴 LOCKED OR UNREACHABLE IS NOT "YOU HAVE NO WORLD BOOKS", and the difference matters more
    // here than on the roster's filter: this control WRITES. An empty list would offer him a
    // dropdown whose only choice is to unassociate the card, which is a destructive answer
    // manufactured out of a failed GET. Show what we know and nothing to press.
    if (seq !== undefined && wbStale(kind, seq)) return;
    wrap.style.display = 'inline-flex';
    sel.disabled = true;
    sel.innerHTML = `<option>${esc(doc.world_name || 'world books unavailable')}</option>`;
    return;
  }
  if (seq !== undefined && wbStale(kind, seq)) return;
  sel.disabled = false;
  const named = !doc.world_held && doc.world_name;
  sel.innerHTML =
    '<option value="">— no world book —</option>' +
    (named ? `<option value="${esc(WORLD_REF)}">${esc(doc.world_name)} — not in Vocalis</option>` : '') +
    books.map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  // 🔴 THE SELECTION IS AN OPTION THAT EXISTS, NEVER THE RECORD'S RAW `world_id` —
  // `wbLoadBookFilter`'s rule, and the same trap it names. Assigning a `value` matching no option
  // silently leaves `''`, so a card linked to a book that is not in the list would read
  // "— no world book —" while the server still held the link, and his next press would be
  // relative to a state the screen never showed.
  const linked = doc.world_id || '';
  const held = !!(doc.world_held && linked && books.some(b => b.id === linked));
  sel.value = held ? linked : named ? WORLD_REF : '';
  wrap.style.display = 'inline-flex';
}

/**
 * @param {string} kind
 * @param {string} id
 * @param {number} [revision] - omitted or nullish means "the latest".
 * @param {{scrollToRow?: boolean}} [opts]
 */
export async function wbOpen(kind, id, revision, opts) {
  const st = wbState(kind);
  // 🔴 5.1. THREE SEQUENTIAL FETCHES, AND `st` USED TO BE WRITTEN BETWEEN THEM. Click row A then
  // row B before A lands and you finish with `st.doc = B` while `st.rev`, `st.fields` and the
  // rendered textareas are A's — after which Save POSTs A's locators and A's revision number to
  // document B, `wbSaveDraft` files A's locator in B's draft, and `wbStSend` sends B at A's
  // revision number. The row handler and the revision picker both call this unawaited with
  // nothing disabled, so it is reachable with two ordinary clicks.
  //
  // The token is taken FIRST and every write to `st` happens after the last await, together.
  const seq = wbBump(kind);
  // 5.2 — a pass stream belongs to the document that started it. Opening another one leaves it
  // driving the new document's pane: `wbFetchProposal` builds a URL with the NEW id, 404s, drops
  // the rejection, and because `st.seen.add(index)` runs before its await the row is never
  // retried. A's entire review queue silently disappears. Close it before we switch.
  wbCloseStream(kind);
  // A warm is only for the latest World Book. Older revision picks and cards use the ordinary
  // authoritative fetch path, while a completed warm avoids all three open-time reads.
  const warmed = kind === 'books' && revision == null ? wbTakeWarmBook(id) : null;
  const doc = /** @type {WbDoc} */ (warmed ? warmed.doc : await jget('/wbedit/documents/' + encodeURIComponent(id)));
  if (wbStale(kind, seq)) {
    if (warmed) warmed.host.remove();
    return;
  }
  const n = revision == null ? doc.latest : revision;
  const warmBook = warmed && warmed.doc.latest === n ? warmed : null;
  const [fields, rev] = warmBook
    ? [warmBook.fields, warmBook.rev]
    : await Promise.all([
        jget('/wbedit/documents/' + encodeURIComponent(id) + '/fields?revision=' + n),
        jget('/wbedit/documents/' + encodeURIComponent(id) + '/revision/' + n),
      ]);
  if (wbStale(kind, seq)) {
    if (warmed) warmed.host.remove();
    return;
  }
  if (warmed && !warmBook) warmed.host.remove();
  st.doc = doc;
  st.rev = rev;
  st.fields = fields.fields;
  // A draft map belongs to the document it was typed into. Carrying it across a switch is how
  // a late PUT seeds the NEXT document's dedupe map (the `wbSaveDraft` low item).
  st.draftAt = {};
  // m5g / §9a.26 — the typed field table. It travels WITHOUT values: the revision above already
  // holds every one of them, and a second copy on the wire is the one that goes stale.
  st.spec = fields.entry_fields || [];
  st.specGroups = fields.entry_groups || [];
  st.specByName = {};
  /** @type {WbSpecField[]} */ (st.spec).forEach(s => {
    st.specByName[s.name] = s;
  });
  // Which settings folds are open belongs to the DOCUMENT, not to the pane. Opening a different
  // book must not reopen row 12 because row 12 was open in the last one.
  // §9a.31 — and the entry accordion is indexed the same way, so it has the same rule and must be
  // cleared at the same moment. A stale `openRows` would open row 12 of the new book AND suppress
  // the first-entry-open default, because "we already know his layout" is exactly what a non-empty
  // set means to `wbShutInit`.
  if (st.openId !== id) {
    st.setOpen = new Set();
    st.openRows = new Set();
  }

  /** @type {VEl} */ (wbEl(kind, 'wbDocName')).textContent = doc.name;
  /** @type {VEl} */ (wbEl(kind, 'wbRevLabel')).textContent = 'revision ' + n + (n === doc.latest ? ' (latest)' : ' — older');
  // 🔴 `seq`, AND UNAWAITED ON PURPOSE. It carries `wbOpen`'s own generation so a slow books
  // fetch cannot paint over a card the user has since clicked away from; awaiting it would put
  // a fourth round trip in front of the fields, which is the pane's whole visible latency.
  wbShowWorld(kind, doc, seq);
  wbShowCard(kind, doc);
  // m4n — every revision carries WHEN. A column of bare numbers cannot answer "which one was before
  // lunch", which is the only question a revision picker really gets asked.
  /** @type {Record<number, number>} */
  const stamps = {};
  (doc.revision_index || []).forEach(m => {
    stamps[m.n] = m.created_at;
  });
  // 🔴 NEWEST FIRST. The store lists
  // them ascending because the filesystem is the authority on what EXISTS; what he reaches for is
  // almost always the latest or the one just before it, and putting revision 0 at the top of a
  // thirty-entry list buries both. `.slice()` because `doc.revisions` is read elsewhere.
  // 🔴 7.3.9g — REVISION 0 SAYS WHAT IT IS.
  //
  // ⚠️ **AND THE ANSWER IS A LABEL, NOT A RENUMBER.** The number is the document's own identity,
  // not a display index: it is in `/revision/<n>`, in `doc.latest`, in the draft file's `revision`
  // key, in `rollback(n)` and in every "saved as revision N" message. Showing 1-based
  // while the store counts from 0 would put a different number on the screen from the one in the
  // URL bar and in the message the save just printed — a far worse kind of weird, and unfixable
  // without renumbering history that §4 promises never rewinds.
  //
  // The real confusion is that 0 does not look like a revision, and it is not one: it is the
  // document as it ARRIVED, before anyone edited anything. Saying so turns an apparent off-by-one
  // into the baseline it actually is, and the edits stay 1, 2, 3.
  /** @type {VEl} */ (wbEl(kind, 'wbRevPick')).innerHTML = doc.revisions
    .slice()
    .reverse()
    .map(
      r =>
        `<option value="${r}"${r === n ? ' selected' : ''}>revision ${r}` +
        `${r === 0 ? ' (original)' : ''}${r === doc.latest ? ' (latest)' : ''}${wbWhen(stamps[r])}</option>`,
    )
    .join('');
  /** @type {VEl} */ (wbEl(kind, 'wbRollback')).style.display = n === doc.latest ? 'none' : '';
  wbSaveGate(kind, n === doc.latest);
  st.openId = id;
  wbPane(kind).style.display = '';
  wbPlaceEditor(kind);
  /** @type {VEl} */ (wbEl(kind, 'wbReview')).style.display = 'none';
  // §6.4.3 — the log follows the REVISION on screen. Opening a document, or picking a different
  // revision, shows that version's saved log in full; there is nothing to carry over from the
  // previous document, and a stale live log would read as "this is what we sent about THIS card".
  wbLogStop(kind);
  /** @type {VEl} */ (wbEl(kind, 'wbLog')).style.display = '';
  wbLogFold(kind);
  /** @type {VEl} */ (wbEl(kind, 'wbLogBody')).innerHTML = '<span class="muted">reading…</span>';
  wbLoadSavedLog(kind, n).catch(() => {
    /** @type {VEl} */ (wbEl(kind, 'wbLogBody')).innerHTML = '<span class="muted">could not read this revision\'s log</span>';
  });

  // Every field on ONE scrollable page, each in its own block, each individually editable —
  // §6.1.2, and the reason this feature exists at all.
  if (warmBook) {
    wbUseWarmBook(warmBook);
  } else {
    let lastGroup = '';
    /** @type {VEl} */ (wbEl(kind, 'wbFields')).innerHTML =
      st.fields
        .map(
          /** @type {(f:WbField, i:number) => string} */ (
            (f, i) => {
              const text = wbGetAt(rev.content, f.locator);
              // I9's courtesy dimming, keyed on the entry's OWN name. ⚠️ This was `/^X-/i` until m4k gave a
              // card's embedded lorebook entries a `card book · ` prefix — which silently un-dimmed every
              // X-titled entry inside one. It is only a courtesy (I9: "not a boundary, and nothing may
              // depend on it"), which is exactly why it would have gone unnoticed.
              const x = /(?:^|·\s*)X-/i.test(f.label);
              const m = wbMode(f.mode);
              // m4k / §9a.5 — a heading, drawn once when the group changes. `embedded book #0`
              // could be mistaken for a World Book leaking into the card pane; it is the card's own
              // lorebook, it lives in the PNG, and this editor is the only place it can be edited.
              // 🔴 A HEADING, NOT A FOLD. Hiding these behind a toggle would recreate the failure the label
              // caused — a user could tick "all fields" for a rename sweep and silently miss the character's own
              // lorebook.
              const head = f.group && f.group !== lastGroup ? `<h4 class="wbgroup">${esc(f.group)}</h4>` : '';
              lastGroup = f.group || '';
              // m5d — `pass_default` is the SERVER's answer (`Job.meta`), so the checkbox and the pass route
              // cannot disagree about which fields are machinery. `!== false` and not a truthiness test: a
              // worldbook or persona field never carries the key at all, and those are all ticked.
              const pd = f.pass_default !== false;
              // §9a.31 — 🔴 THE HEADER OF AN ENTRY IS A FOLD CONTROL; THE HEADER OF A FIELD IS STILL A LABEL.
              // A `<label>` wrapping the input forwards every title-bar click to the checkbox, so the
              // element has to stop being a label for the click to mean anything else.
              //
              // 🔴 ENTRIES ONLY, and a card's own fields keep the `<label>`. §6.1.2 is "every field on ONE
              // scrollable page" and it is the reason this editor exists; a card's `description` has no fold
              // to control, so turning its header into a div would remove click-to-tick and give nothing
              // back. `f.entry` is the SERVER's flag, never a guess from the locator shape.
              const isE = !!f.entry;
              const hd = isE ? 'div' : 'label';
              // §9a.29's passive marker. The SERVER's answer (`worldbook.py`'s one predicate), never a
              // `!f.keys.length` here — the raw key list keeps blank strings, so a browser-side test would
              // call `key: [""]` keyed and disagree with the route that refuses to save it.
              const inert = !!f.inert;
              // 🔴 §9a.32 — THE FIELD THAT IS NOT THERE YET. A card that arrived with no `system_prompt`
              // had no row for one, so the
              // only way to add it was in SillyTavern. The row exists now, empty and typable.
              //
              // 🔴 THE CHECKBOX IS DISABLED, AND THAT IS NOT COSMETIC. A pass over an empty field hands the
              // model nothing to rewrite and it answers anyway — inventing the contract I13 exists to keep
              // it away from. The SERVER already refuses to collect empty fields for a pass, so a ticked
              // one would be a control that ticks, counts in the preflight, and does nothing on Run: the
              // dead-control failure this pane keeps re-learning. Disabled, never hidden (§9a.27's rule).
              const isEmpty = !!f.empty;
              const emptyTip =
                'This field is empty. Type into it and press Save to give the card one — it ' +
                'is written into the document exactly like any other field, and goes to SillyTavern with ' +
                'the next ⬆ Save to SillyTavern. It cannot be included in a pass while it is empty: ' +
                'there would be nothing to rewrite, and the model would invent something.';
              return `${head}<div class="wbfield${x ? ' wbx' : ''}${m ? ' m' + f.mode : ''}${inert ? ' wbinert' : ''}${isEmpty ? ' wbempty' : ''}" data-i="${i}" data-mode="${esc(f.mode || '')}">
      <${hd} class="wbhead">
        <input type="checkbox" class="wbtick" data-i="${i}"${pd ? ' checked' : ''} title="${esc(isEmpty ? emptyTip : WB_TICK_TIP)}"${isEmpty ? ' disabled' : ''}>
        ${isE ? '<span class="wbcar" aria-hidden="true"></span>' : ''}
        ${m ? `<span class="wbdot m${f.mode}" title="${esc(m.tip)}">${m.glyph}</span>` : ''}
        <b>${esc(f.label)}</b>
        ${inert ? '<span class="wbinerttag" title="This entry has no keywords and is not always-injected, so SillyTavern stores it, shows it, and never fires it. Give it a keyword, or set it to always injected.">no keywords — never fires</span>' : ''}
        ${isEmpty ? `<span class="wbemptytag" title="${esc(emptyTip)}">empty — type to add it</span>` : ''}
        <span class="small muted" title="${esc(isEmpty ? emptyTip : WB_TICK_TIP)}">${isEmpty ? 'not on this card yet' : `${f.chars} chars`}${x ? ' · X — shown collapsed by courtesy, not withheld' : ''}</span>
      </${hd}>
      <textarea class="wbtext" data-i="${i}"${isEmpty ? ' placeholder="Empty. Type here and press Save to add this field to the card."' : ''} rows="${Math.min(18, Math.max(3, Math.ceil(text.length / 90)))}">${esc(text)}</textarea>
      ${
        f.entry
          ? `<div class="wbkeys"><div class="wbsetbody wbkeysbody"></div></div>
      <div class="wbset">
        <button type="button" class="wbsetog" data-i="${i}">⚙ settings</button>
        <div class="wbsetbody" hidden></div>
      </div>`
          : ''
      }
    </div>`;
// Give an empty world book a specific empty-state message that points to Add entry. The generic
// no-editable-fields message is accurate but does not identify the available action.
              //
              // ⚠️ Books only. On a card the generic line is right: a card with no editable fields is a card
              // whose prose is all empty, and pointing at ✚ Add entry there would be pointing at a button
              // that is not on that pane.
            }
          ),
        )
        .join('') ||
      (kind === 'books'
        ? '<span class="muted">This World Book has no entries yet. Press ✚ Add entry, above, to make one.</span>'
        : '<span class="muted">This document has no editable fields.</span>');
  }
  // m5g / §9a.26 — the settings fold. `f.entry` is the SERVER's answer to "is this an entry in a
  // compiled worldbook", never `locator[:-1]`: that inference is right for every worldbook row and
  // wrong for a card's own `description`, and a rule that is right by coincidence is one refactor
  // from offering `sticky` on a character card.
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbsetog').forEach(b =>
    b.addEventListener('click', ev => {
      ev.preventDefault();
      wbSetToggle(kind, /** @type {Element} */ (b.closest('.wbfield')));
    }),
  );
// §9a.35 — the primary keywords box, built for every entry HERE rather than on a disclosure.
// A save is refused without one (§9a.29a),
  // so this is the only control on the row that the document cannot be valid without.
  //
  // ⚠️ EAGER, AND THAT IS THE POINT rather than an oversight of §9a.31's laziness rule. The fold
  // is lazy because it is 38 controls per entry and the page is already tall; this is one text
  // input, and a control that must always be visible cannot be built when it is opened.
  //
  // 🔴 IT IS BUILT AFTER `wbRestoreDrafts`, FURTHER DOWN, AND NOT HERE. `wbSetFill` drapes the
  // pending edits over the revision as it renders (7.3.9c), reading them out of `st.draftAt` —
  // which is empty until the draft fetch lands. Built at this point the box shows the SAVED
  // keywords under a row marked dirty, and `wbSetEdits` then reads that stale value at Save time.
  // The fold never had this problem only because it is lazy: by the time he opens one, the
  // restore is long done. The browser spec caught it as a keyword draft that came back as its
  // original value.
  // §9a.31 — the entry header IS the fold control. Bound only on entry rows: a card field's header
  // is still a `<label>` and the browser's own label behavior is what ticks it.
  //
// Exempt checkboxes from the fold handler so selecting an entry does not also close its row.
// Use `closest('.wbtick')`
  // rather than `ev.target === c` because the hit area of an input is not always the input.
  //
// The mode dot is exempt too — it is `cursor:help` and carries the only explanation of what
// the modes mean, so reading its tooltip must not close the row.
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbfield').forEach(box => {
    const f = st.fields[+(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i))];
    if (!f || !f.entry) return;
    const head = box.querySelector('.wbhead');
    if (!head) return;
    head.addEventListener('click', ev => {
      if (/** @type {Element} */ (ev.target).closest('.wbtick') || /** @type {Element} */ (ev.target).closest('.wbdot')) return;
      wbShutToggle(kind, box);
    });
  });
  // m4x — the fold is re-painted on every tick, so ticking a collapsed field brings its body back
  // immediately. That is what keeps the header row a control rather than a dead label.
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbtick').forEach(c =>
    c.addEventListener('change', () => {
      wbFoldPaint(kind);
      wbPreflight(kind);
    }),
  );
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbtext').forEach(t => {
    t.addEventListener('input', () => wbMarkDirty(kind, t));
    // §9a.15 — leaving a box is the commit point for the pending state.
    t.addEventListener('blur', () => wbSaveDraft(kind, t));
  });
  wbFindClose(kind);
  await wbRestoreDrafts(kind);
  // §9a.35 — the always-visible primary keywords box, built HERE because `st.draftAt` only holds
  // his pending edits once the line above has landed. See the long note at the markup site.
  /** @type {VEl} */ (wbEl(kind, 'wbFields'))
    .querySelectorAll('.wbkeysbody')
    .forEach(b => wbKeysBuild(kind, /** @type {Element} */ (b.closest('.wbfield'))));
// Apply the stale-generation guard to the draft read too. It starts when the editor first appears,
// so closing during the request can land `wbCloseEditor` inside its window. Close bumps the
  // generation and sets `st.fields = []`, and it deliberately does NOT empty `#wbFields`: the rows
  // are still in the DOM, merely hidden. Everything below walks those rows and indexes `st.fields`
  // by their `data-i` — so `wbPreflight` → `wbSyncPreviewPick` read `fields[i].label` off an empty
// array and `wbGo` would print a raw TypeError instead of rendering a useful result.
  //
  // ⚠️ ONE RETURN, NOT A GUARD PER CALLEE. Nine calls follow, every one of them a repaint of a
  // pane that is no longer showing anything, so the honest fix is not to make the run. The second
  // half of this fix lives in `wbTicked` (edit.js) and is for the general hazard rather than for
  // this path: it stopped handing out a row index with no field behind it, which is what
  // `wbSyncPreviewPick`, `wbPreflight` and `wbRun` were all trusting.
  if (wbStale(kind, seq)) return;
  wbRestoreReview(kind).catch(() => {}); // never block the open on it
  // m4x — the fold survives opening another document, because it is a way of working rather than a
  // property of one book. Re-asserted rather than assumed: the rows were just rebuilt from scratch,
  // so the classes are gone, and this also re-syncs the button's label with the state.
  // 🔴 `wbFolded` IS `edit.js`'s EXPORT, UNTYPED THERE — cast at this use site rather than in
  // edit.js, which is outside this file's scope for 8.3-m2. See the milestone report.
  wbFoldUnticked(kind, !!(/** @type {Record<string, boolean>} */ (wbFolded)[kind]));
  // m5g — and so are the settings folds. A save re-opens the document (that is how the revision on
  // screen becomes the new one), and closing the four panes he had just arranged as the reward for
  // pressing Save is the same "it threw away my place" failure the scroll restore fixes.
  if (st.setOpen && st.setOpen.size) {
    const want = new Set(st.setOpen);
    st.setOpen = new Set();
    /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbfield').forEach(box => {
      // `:not(.wbkeysbody)` — §9a.35's always-visible keywords box shares the class, and this
      // guard means "does this row have a ⚙ FOLD to reopen".
      if (
        want.has(+(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i))) &&
        box.querySelector('.wbsetbody:not(.wbkeysbody)')
      )
        wbSetToggle(kind, box);
    });
  }
  // §9a.31 — the accordion, after the settings folds and BEFORE the mode filter. Order matters
  // both ways: `st.setOpen` above calls `wbSetToggle`, which is about the ⚙ pane and must not be
  // confused with this; and `wbFilterPaint` below adds `.wbhide`, which is a different axis again
  // (a filtered-out row is gone, not shut) and must be applied over the top of a settled fold.
  wbShutInit(kind);
  wbEntryCtl(kind);
  // §9a.27 — the top Save is always on screen, so it has to be re-gated on every open: a freshly
  // opened document is clean, and an older revision cannot be saved over at all.
  wbSaveShow(kind);
  wbFilterPaint(kind); // m4y — the rows were just rebuilt, so the filter is re-asserted
  wbPreflight(kind);
  wbSyncRowButtons(kind);
  if (!(opts && opts.scrollToRow === false)) wbScrollToRow(kind, id);
}

// ── the review queue survives a restart too (§9a.16) ─────────────────────────
//
// The server persists proposals before advancing the cursor, and `review()` persists each
// verdict the same way. But
// `wbAddProposal` was only ever called from the SSE stream, and `wbOpen` hid the Review card
// outright, so a refresh showed an empty pane over a complete queue sitting on disk. Same shape
// as §9a.13a: state that survives, and a UI that implies it did not.
//
// 🔴 **A PASS THAT ALREADY BECAME A REVISION IS NOT RESTORED.** `materialize` stamps the new
// revision with its `pass_id`, so any pass named there is finished business. Re-offering it would
// invite a second Apply and a duplicate revision on top of the first.
//
// ⚠️ **ONE FETCH PER PROPOSAL, DELIBERATELY.** `GET /wbedit/pass/<doc>/<pass>` is metadata-only on
// purpose — its docstring refuses a bulk route because it "would put a whole book's worth of
// before/after text into one response that some proxy will buffer". So the rows are fetched one
// at a time and appended as they arrive, which also means a long queue paints progressively
// instead of hanging the open.
/** @param {string} kind */
async function wbRestoreReview(kind) {
  const st = wbState(kind);
  if (!st.doc || !st.doc.id) return;
  const applied = new Set(/** @type {WbRevisionIndexEntry[]} */ (st.doc.revision_index || []).map(r => r.pass_id).filter(Boolean));
  const cand = /** @type {WbPassRow[]} */ (st.doc.passes || [])
    .filter(p => p.id && !applied.has(p.id) && p.status !== 'running')
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  if (!cand) return;

  const base = `/wbedit/pass/${encodeURIComponent(st.doc.id)}/${encodeURIComponent(cand.id)}`;
  const meta = await jget(base);
  // Only rows that proposed something. NOCHANGE and FAILED rows have nothing to approve, and
  // `review: 'none'` is the store's own way of saying "there was never a decision to make here".
  const rows = /** @type {WbProposalRow[]} */ (meta.proposals || []).filter(p => p.status === 'CHANGED' && p.review !== 'none');
  if (!rows.length) return;

  st.pass = { id: cand.id };
  /** @type {VEl} */ (wbEl(kind, 'wbProposals')).innerHTML = '';
  /** @type {VEl} */ (wbEl(kind, 'wbReview')).style.display = '';
  /** @type {VEl} */ (wbEl(kind, 'wbReviewCount')).textContent = 'reading ' + rows.length + '…';
  for (const m of rows) {
    // 🔴 THE OPEN MAY HAVE MOVED ON. A slow queue and an impatient click would otherwise pour
    // one document's proposals into another's pane.
    if (wbState(kind).doc?.id !== st.doc.id || wbState(kind).pass?.id !== cand.id) return;
    try {
      wbAddProposal(kind, await jget(`${base}/proposal/${m.index}`));
    } catch (e) {
      /* one unreadable row is not a reason to lose the rest of the queue */
    }
  }
  const n = /** @type {VEl} */ (wbEl(kind, 'wbProposals')).childElementCount;
  if (!n) {
    /** @type {VEl} */ (wbEl(kind, 'wbReview')).style.display = 'none';
    return;
  }
  wbSay(kind, `${n} proposal${n === 1 ? '' : 's'} from an earlier pass are still waiting for you`);
}

// Re-drape the pending text over the revision after a reload. Ordered AFTER the field render and
// BEFORE the preflight, so the counts he reads describe what is actually on screen.
/** @param {string} kind */
async function wbRestoreDrafts(kind) {
  const st = wbState(kind);
  st.draftAt = {};
  if (!st.doc || !st.rev) return;
  // 🔴 NOT IN THE REVIEW. This is awaited from inside `wbOpen`, and it paints text into textareas
  // by `dataset.i` — so a second `wbOpen` starting while this `jget` is in flight had it drape
  // document A's drafts over document B's boxes, marked dirty, with a message saying so.
  const seq = wbGen(kind);
  let body;
  try {
    body = await jget(`/wbedit/documents/${encodeURIComponent(st.doc.id)}/draft/${st.rev.n}`);
  } catch (e) {
    return;
  } // no drafts is the common case, and a 404 is not news
  if (wbStale(kind, seq)) return;
  const fields = (body && body.fields) || {};
  // 7.3.9e — what is on DISK, which is not always what we can restore. See the route: they differ
  // only for a draft stranded against an older revision, and this is the only way the UI learns
  // one exists. `↺ Revert changes` reads it so that state is clearable rather than a permanent
  // orange count on the roster. Read before the early return — a document with a stranded draft
  // and nothing for this revision returns here with `fields` empty and `total` non-zero.
  st.draftTotal = (body && +body.total) || 0;
  wbSaveShow(kind);
  // 7.3.9g — a roster rendered BEFORE this document was opened has no marker on it yet (the
  // listing is fetched once, and a draft can be created after it). Same one-line patch as the
  // blur and the revert, so all three moments the count can change agree.
  wbSyncRowPending(kind, st.doc.id, /** @type {number} */ (st.draftTotal));
  const keys = Object.keys(fields);
  if (!keys.length) return;
  let restored = 0;
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbtext').forEach(ta => {
    const f = st.fields[+(/** @type {string} */ (/** @type {HTMLTextAreaElement} */ (ta).dataset.i))];
    if (!f) return;
    const k = JSON.stringify(f.locator);
    if (!(k in fields)) return;
    /** @type {HTMLTextAreaElement} */ (ta).value = fields[k];
    st.draftAt[JSON.stringify(f.locator)] = fields[k];
    wbMarkDirty(kind, ta);
    restored++;
  });
  // 🔴 7.3.9c — AND THE ⚙ FOLD'S FIELDS, WHICH WERE NEVER STASHED AND SO WERE NEVER RESTORED.
  //
  // 🔴 **THE FOLD IS BUILT EVEN THOUGH IT STAYS SHUT, AND THAT IS THE WHOLE POINT.** `wbSetEdits`
  // walks only `.wbsetbody[data-built]`, so a pending keyword sitting in a fold he has not opened
  // this session would be restored, painted dirty, and then silently DROPPED by Save — a worse
  // outcome than not restoring it, because the row promises the edit is there. Building is not
  // showing: `wbSetBuild` fills the body and marks it built, `wbSetToggle` is what unhides it, and
  // the `st.setOpen` restore below still decides what he actually sees.
  //
  // ⚠️ ORDER: this must run BEFORE that restore, which calls `wbSetToggle` → `wbSetBuild`. Built
  // first here, that call is a no-op on `data-built` and the drafts are already draped; the other
  // way round the fold would be built from the bare revision and the pending values lost again.
  let settings = 0;
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbfield').forEach(box => {
    const f = st.fields[+(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i))];
    if (!f || !f.entry) return;
    const mine = /** @type {WbSpecField[]} */ (st.spec || []).filter(s => wbDraftSetKey(f, s.name) in fields);
    if (!mine.length) return;
    // Into `st.draftAt` FIRST — `wbSetBuild` reads it to drape the values, `↺ Discard` counts it,
    // and `wbSaveSetDraft` dedupes against it. Populating it after the build would show the right
    // thing once and then re-PUT every field on the next blur.
    mine.forEach(s => {
      st.draftAt[wbDraftSetKey(f, s.name)] = fields[wbDraftSetKey(f, s.name)];
    });
    wbSetBuild(kind, box);
    settings += mine.length;
  });
  const n = restored + settings;
  if (n)
    wbSay(
      kind,
      `${n} unsaved edit${n === 1 ? '' : 's'} restored — ` + 'press Save to make them a revision, or Close to leave them pending',
    );
}

// ── ↺ Discard — §1.2, and the button that never did anything ─────────────────────────────────
//
// 🔴 IT USED TO CALL `wbOpen(kind, doc.id, rev.n)`, WHICH IS THE EXACT OPPOSITE OF DISCARDING.
// Re-opening the revision runs `wbRestoreDrafts`, which re-applies the drafts from the server,
// re-marks every one of them dirty and prints *"2 unsaved edits restored"* — identical text, Save
// bar still up. So the one control for abandoning pending edits restored them instead, and
// `DELETE /wbedit/documents/<id>/draft` had existed on the server since m2 **with no caller
// anywhere in the UI**. There was no way at all to throw away pending typing.
//
// ⚠️ CONFIRMED, BECAUSE IT DESTROYS WORK AND CANNOT BE UNDONE. A draft is the only copy of
// user-authored text not yet saved; the server deletes the file outright. Every other
// destructive control in this pane asks first (delete a document, delete an instruction), and
// this is the one that looks least dangerous while being just as final.
/** @param {string} kind */
export async function wbDiscard(kind) {
  const st = wbState(kind);
  if (!st.doc || !st.rev) {
    wbSay(kind, 'Open a document first.', true);
    return;
  }
  // 🔴 7.3.9e — THE SERVER'S TOTAL IS THE FALLBACK, AND IT IS WHAT MAKES A STRANDED DRAFT
  // CLEARABLE. `st.draftAt` holds what was restored ONTO THIS REVISION; a draft left stamped at an
  // older one (a crash between `add_revision`'s write and its carry) restores nothing, so this map
  // is empty while `draft.json` is not. Reading only the map meant "nothing to discard" over a
  // file that exists — and since 7.3.9d the roster shows an orange count for it, so the one
  // control for getting rid of it refused to act on the only thing that could still see it.
  const onScreen = Object.keys(st.draftAt || {}).length;
  const pending = onScreen || st.draftTotal || 0;
  if (!pending) {
    wbSay(kind, 'nothing to discard — there are no unsaved edits.', 'ok');
    return;
  }
  // ⚠️ SAY WHICH CASE HE IS IN. "Throw away 2 unsaved edits" over an editor showing none reads as
  // a bug in the count; naming the older revision explains it and is the honest description of
  // what the button is about to delete.
  if (
    !(await wbConfirm(
      'Revert changes?',
      `<p>Throw away <b>${pending}</b> unsaved edit${pending === 1 ? '' : 's'} and go back to ` +
        `revision ${st.rev.n} as it is stored?</p>` +
        (onScreen
          ? ''
          : '<p class="small">These were typed against an <b>earlier revision</b> and cannot be shown ' +
            'here, which is why the editor looks unchanged. Discarding is the only thing left to do ' +
            'with them.</p>') +
        '<p class="small muted">This cannot be undone — a pending edit has never been written to a ' +
        'revision, so there is nothing to roll back to.</p>',
      'Revert changes',
      true,
    ))
  )
    return;
  const seq = wbGen(kind),
    docId = st.doc.id,
    revN = st.rev.n;
  try {
    await jdel(`/wbedit/documents/${encodeURIComponent(docId)}/draft`);
  } catch (e) {
    const ex = /** @type {ErrLike} */ (e);
    wbSay(
      kind,
      ex.status === 423
        ? 'The vault is locked — nothing was discarded.'
        : (ex.body && /** @type {string} */ (ex.body.error)) || ex.message || 'could not discard',
      'bad',
    );
    return;
  }
  st.draftAt = {};
// 🔴 7.3.9g — AND THE ROW BESIDE IT. Revert left the editor clean while the Library
// line still read "(1 pending edit)" — right until a hard refresh. Save was already
  // correct only by accident: it re-fetches the whole library for unrelated reasons. Reverting did
  // not, so the two halves of the same screen disagreed about the same document.
  st.draftTotal = 0;
  wbSyncRowPending(kind, docId, 0);
  wbSay(kind, `reverted ${pending} unsaved edit${pending === 1 ? '' : 's'}.`, 'ok');
  if (wbStale(kind, seq)) return;
  // Now re-opening is correct rather than self-defeating: the drafts are gone from the server, so
  // `wbRestoreDrafts` finds nothing and the fields come back as the revision stores them.
  await wbOpen(kind, docId, revN);
}

// ── the Library row is the control, not the button on it ─────────────────────
//
// All four are one idea: the row is a disclosure control, so it has to behave like one — toggle,
// whole-target, honest label, and it must bring the thing it opened into view.

//: Open and Close are the SAME control, so the label has to follow the state rather than be
//: written once at render time. Walking the rows is right (not just the two that changed):
//: `wbLoadLib` re-renders from scratch, and only one row can be open, so this is also what makes
//: a stale "Close" impossible after a filter or a sweep repaints the list.
/** @param {string} kind */
function wbSyncRowButtons(kind) {
  const lib = /** @type {VEl} */ (wbEl(kind, 'wbLib'));
  if (!lib) return;
  const openId = wbState(kind).openId;
  lib.querySelectorAll('.wbrow').forEach(row => {
    // ⚠️ `button.wbopen`, NOT `.wbopen`. The PORTRAIT carries that class too (it is a click
    // target of its own) and it is the row's first child — so the bare selector finds the face
    // and writing textContent onto it replaces the picture with the word "Open".
    const btn = row.querySelector('button.wbopen');
    if (btn) btn.textContent = /** @type {HTMLElement} */ (row).dataset.id === openId ? 'Close' : 'Open';
  });
}

//: 🔴 THE EDITOR OPENS INLINE UNDER THE ROW, WHICH IS ABOVE THE CLICK WHEN THE ROW IS BELOW THE
//: FOLD. Without this the page does not move: the card genuinely opened, several screens up, and
//: it reads as "nothing happened" — which is the same class of failure as item 4's held proposal.
//: A third of the way down rather than the top, so the rows above stay visible as context and he
//: can see he is still in the Library.
/**
 * @param {string} kind
 * @param {string} id
 */
function wbScrollToRow(kind, id) {
  // 🔴 AFTER LAYOUT, NOT DURING IT. `wbOpen` has just written the editor into the row's slot and
  // the roster's faces load EAGERLY, so at this instant the document is still growing. A
  // `scrollTo` issued now is CLAMPED to the current (shorter) scrollHeight — and when the target
  // is past that clamp the browser scrolls nowhere at all, which is indistinguishable from the
  // feature not existing. It regressed exactly that way the moment the faces stopped being lazy.
  //
  // Two frames: the first lets the style/layout pass run, the second measures the result of it.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const lib = /** @type {VEl} */ (wbEl(kind, 'wbLib'));
      const row = lib && lib.querySelector('.wbrow[data-id="' + CSS.escape(id) + '"]');
      if (!row) return;
      const top = window.scrollY + row.getBoundingClientRect().top - Math.round(window.innerHeight / 3);
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }),
  );
}

//: The one close path. The ✕ button and a second click on the row must not drift apart — they are
//: the same action, and two copies of this is how one of them keeps the log polling.
/** @param {string} kind */
export function wbCloseEditor(kind) {
  const st = wbState(kind);
  // 🔴 CLOSING IS A DOCUMENT SWITCH — TO NOTHING. Bump, or an open that is still in flight lands
  // afterward and silently re-populates `st` for a pane the user has already dismissed.
  wbBump(kind);
  wbCloseStream(kind); // 5.2 — this path never closed the stream either
  st.openId = null;
  // The buttons that act on "the open document" (`wbStSend`, Export, Save) all guard on
  // `st.doc`/`st.rev` and then trust them. Leaving the closed document in place is what made
  // those guards decorative — they were never null after the first open of the session.
  st.doc = null;
  st.rev = null;
  st.fields = [];
  st.draftAt = {};
  wbPane(kind).style.display = 'none';
  wbPlaceEditor(kind); // back to its home position, out of the roster
  /** @type {VEl} */ (wbEl(kind, 'wbReview')).style.display = 'none';
  wbLogStop(kind);
  /** @type {VEl} */ (wbEl(kind, 'wbLog')).style.display = 'none';
  wbSyncRowButtons(kind);
}

// this control has nothing to say — do not send it

// m5d / §9a.21 — a field that is SHOWN but arrives UNTICKED. These fields are available in the
// card; the editor requests them from the server.
//
// 🔴 THE TICK IS THE WHOLE POINT OF SHOWING THEM THIS WAY. I13 says a model turned loose on
// `system_prompt` will do something confident and stupid to a contract — that stays true, so these
// come in unticked and a pass cannot reach them by accident. The user can READ and
// TYPE INTO them, which is the difference between a rule about passes and a rule about visibility.
//
// 🔴 9.9 — THIS TITLE USED TO APPEAR ONLY WHILE THE BOX WAS UNTICKED, on the CHARS SPAN next to
// it, and the trailing text next to it (" · not ticked by default") was baked in at render time
// from the server's default and never repainted on click. Tick the box and both went stale at
// once: a checked checkbox sitting next to text that still says "not ticked by default", which is
// exactly the stale state that was reported. Worse, the checkbox itself never said what it DID
// — hovering it read as "toggle a setting" with no text behind it, which is how "tick = enable it
// to be sent to SillyTavern" ever seemed like a reasonable guess.
//
// Fix is to put ONE explanation on the checkbox itself, worded so it stays true whichever way the
// box is currently sitting, and to drop the stale trailing text rather than try to keep it live.
const WB_TICK_TIP =
  'Selects this field for the NEXT AI editing pass — nothing else. It never saves or sends ' +
  'anything: whatever you type here is included in Save as new revision and Send to SillyTavern ' +
  'either way, ticked or not.';

/** Every tick box he can actually SEE. The three selection verbs all run through this, so "tick
 *  all" over a filtered view means "every entry I can see" — the doc's rule, not an inference. */

// ── m4z / §9a.19: authoring, rather than only editing what arrived ───────────────────────────
//
// Everything in the Library until now came from somewhere — swept out of SillyTavern or uploaded.
// These two are the first documents and entries Vocalis makes itself.
/** @param {string} kind */
export async function wbNewBook(kind) {
  const name = await wbAskName(
    'New World Book',
    'It is created here in Vocalis, empty. Add entries to it, then press Save to SillyTavern when ' + 'you want it over there.',
    '',
  );
  // ⚠️ `wbAskName` returns null for BOTH Cancel and an empty box — it cannot tell them apart, and
  // every other caller in this file treats the pair as "he did not name it". Same here, which is
  // why the help text above asks for a name rather than offering to do without one.
  if (name === null) return;
  const n = String(name).trim();
  let doc;
  try {
    doc = await jpost('/wbedit/books', { name: n });
  } catch (e) {
    const ex = /** @type {ErrLike} */ (e);
    wbSay(
      kind,
      ex.status === 423 ? 'Vocalis is locked — log in first.' : (ex.body && /** @type {string} */ (ex.body.error)) || 'could not create it',
      true,
    );
    return;
  }
  await wbLoadLib(kind);
  await wbOpen(kind, doc.id);
  // 🔴 SAID IN GREEN AND LEFT ON SCREEN. It is empty, it is not in SillyTavern, and both of those
  // are surprising enough that a gray line erasing itself in six seconds is not good enough — the
  // same argument m4n's save confirmation settled ("I don't really know that it worked").
  wbSay(kind, 'created "' + n + '" — it is empty and exists only in Vocalis. Press ✚ Add entry to ' + 'start it.', 'ok');
}

// ── §9a.11 / 7.5.15 — a persona created from nothing, and the PNG half of the same ask ────────
//
// New Personas can be created here and their fields edited before uploading to SillyTavern.
//
// 🔴 THIS BUTTON IS ALSO THE "IMPORT A PERSONA AS A PNG" HALF, because a persona PNG is not a
// document the way a card PNG is. A card carries its JSON in the image's text chunks, so importing
// one is a read; a persona avatar is a plain picture under `User Avatars/` with NO embedded
// metadata at all — the name and the description live in two maps inside `power_user`. A dropped
// PNG would therefore hand us a face and nothing else. Create it here, type the fields, and give
// it that face with ⬆ Upload PNG under the avatar: same destination, and nothing is guessed.
//
// ⚠️ IT ARRIVES WITH NO FIELDS FILLED AND THAT IS WHY `persona_empty` HAD TO SHIP WITH IT.
// `persona.jobs` used to skip blank AND missing fields identically, so a persona minted from
// nothing would have opened on "This document has no editable fields" — a create button whose
// result cannot be typed into. The server now offers the empty boxes to the editor and only to
// the editor; a pass still sees nothing, which is the point (§9a.32's rule, borrowed).
/** @param {string} kind */
export async function wbNewPersona(kind) {
  const name = await wbAskName(
    'New Persona',
    'Your persona — the name SillyTavern shows and the description it injects as you. It is ' +
      'created here in Vocalis, empty: type the description, add a picture with ⬆ Upload PNG, ' +
      'then press Save to SillyTavern when you want it over there.',
    '',
  );
  // ⚠️ null is Cancel OR an empty box; `wbAskName` cannot tell them apart. Same as `wbNewBook`.
  if (name === null) return;
  const n = String(name).trim();
  let doc;
  try {
    doc = await jpost('/wbedit/personas', { name: n });
  } catch (e) {
    const ex = /** @type {ErrLike} */ (e);
    wbSay(
      kind,
      ex.status === 423 ? 'Vocalis is locked — log in first.' : (ex.body && /** @type {string} */ (ex.body.error)) || 'could not create it',
      true,
    );
    return;
  }
  await wbLoadLib(kind);
  await wbOpen(kind, doc.id);
  // 🔴 GREEN AND LEFT ON SCREEN, for `wbNewBook`'s reason — it is empty, it is not in SillyTavern,
  // and both are surprising enough that a gray line erasing itself in six seconds is not enough.
  wbSay(kind, 'created "' + n + '" — it exists only in Vocalis. Fill in the description, then ' + '⬆ Upload PNG gives it a face.', 'ok');
}

// ── §9a.11 / 7.5.19 — the CARDS half, and the smaller one of the two ─────────────────────────
//
// 🔴 FORWARD ASSOCIATION ONLY. There is no reverse roster. A
// card is created here with no world at all — which is already the state of any imported card
// whose book Vocalis does not hold, and every route on this pane handles it.
//
// ⚠️ IT ARRIVES WITH FOURTEEN EMPTY FIELDS, and `card_empty` (7.4 / §9a.32) is what makes them
// typable. Without it this button would open on "This document has no editable fields" — the same
// trap `persona_empty` had to close for ✚ New Persona.
/** @param {string} kind */
export async function wbNewCard(kind) {
  const name = await wbAskName(
    'New Character Card',
    "The character's name — SillyTavern shows this and it is what {{char}} becomes. It is " +
      'created here in Vocalis, empty: type the description and the rest, add a picture with ' +
      '⬆ Upload PNG, then press Save to SillyTavern when you want it over there.',
    '',
  );
  // ⚠️ null is Cancel OR an empty box; `wbAskName` cannot tell them apart. Same as `wbNewBook`.
  if (name === null) return;
  const n = String(name).trim();
  let doc;
  try {
    doc = await jpost('/wbedit/cards', { name: n });
  } catch (e) {
    const ex = /** @type {ErrLike} */ (e);
    wbSay(
      kind,
      ex.status === 423 ? 'Vocalis is locked — log in first.' : (ex.body && /** @type {string} */ (ex.body.error)) || 'could not create it',
      true,
    );
    return;
  }
  await wbLoadLib(kind);
  await wbOpen(kind, doc.id);
  // 🔴 GREEN AND LEFT ON SCREEN, for `wbNewBook`'s reason — it is empty and it is not in
  // SillyTavern, and both are surprising enough that a gray line erasing itself is not enough.
  wbSay(kind, 'created "' + n + '" — it exists only in Vocalis. Fill in the fields, then ' + '⬆ Upload PNG gives it a face.', 'ok');
}

// 🔴 THIS MINTS A REVISION ON THE PRESS, WHICH IS NOT HOW THE REST OF THE EDITOR WORKS.
//
// Everywhere else, typing is a draft and Save is what commits. It cannot work that way here:
// `/edit` refuses a locator that does not already resolve, and `set_at` only assigns a leaf, so an
// entry that exists only in the browser has nowhere to be saved TO. The entry has to exist in a
// revision before the editor can address it at all — so the button creates it, and the placeholder
// text he then replaces goes through the ordinary draft-and-save path like any other field.
/** @param {string} kind */
export async function wbAddEntry(kind) {
  const st = wbState(kind);
  if (!st.doc || !st.rev) {
    wbSay(kind, 'Open a World Book first.', true);
    return;
  }
  // 🔴 PINNED BEFORE THE MODAL, and this one is a WRITE. `wbAskName` waits for a human while the
  // roster stays clickable, so reading `st.doc.id` and `st.rev.n` afterward could mint an entry
  // on one document at another document's revision number. Same shape as `wbApply`/`wbRename`.
  const seq = wbGen(kind),
    docId = st.doc.id,
    revN = st.rev.n;
  const comment = await wbAskName(
    'Add an entry',
    'What to call the entry — SillyTavern calls this the comment, and it is what the editor shows ' +
      'as the row title. Adding an entry mints a revision straight away, so the version you have ' +
      'now stays exactly as it is.',
    '',
  );
  // ⚠️ null is Cancel OR an empty box; `wbAskName` cannot tell them apart. See `wbNewBook`.
  if (comment === null) return;
  if (wbStale(kind, seq)) {
    wbSay(kind, 'Not added — you moved to another document.', true);
    return;
  }
  let r;
  try {
    r = await jpost('/wbedit/documents/' + encodeURIComponent(docId) + '/entry' + '?revision=' + revN, { comment: String(comment).trim() });
  } catch (e) {
    const ex = /** @type {ErrLike} */ (e);
    wbSay(
      kind,
      ex.status === 423
        ? 'Vocalis is locked — log in first.'
        : // 409 = the base stopped being the head while `wbAskName` was open (revision-conflict guard).
          // Adding anyway would rebuild the head from that base and take the revisions in
          // between with it, which is `wbSave`'s §1.1 rule applied to the door beside it.
          ex.status === 409
          ? 'this book moved to revision ' +
            ((ex.body && /** @type {any} */ (ex.body).latest) ?? '?') +
            ' while that box was open — nothing was added. Reopen it and try again.'
          : (ex.body && /** @type {string} */ (ex.body.error)) || 'could not add an entry',
      true,
    );
    return;
  }
  // Same rule as ⬆ Import entry: a revision was minted, so a silent return is a write he is
  // never told about (revision-conflict guard).
  if (wbStale(kind, seq)) {
    wbSay(kind, 'the entry was added to the book you were on — it is revision ' + (r.revision == null ? '?' : r.revision) + ' now.', 'ok');
    return;
  }
  await wbLandOnNewEntry(kind, docId, r.revision, true);
  // m5e / §9a.22 — the order is SAID, because it is the one property of a new entry that decides
  // whether it survives the World Info budget and there is nowhere else in Vocalis to see it.
  // The creation message includes the assigned order because it determines priority under the
  // World Info budget.
  wbSay(
    kind,
    'added an entry as revision ' +
      r.revision +
      (r.order == null
        ? ''
        : ' at order ' + r.order + ' (matching this book; higher wins ' + 'when the World Info budget fills — change it in SillyTavern)') +
      ' — replace the placeholder text, then Save.',
    'ok',
  );
}

/**
 * The last third of ✚ Add entry, which is now also the last third of ⬆ Import entry (7.3.20):
 * reload the roster, reopen the book at the revision that was just minted, and put the new row —
 * the last one, because that is the order it was appended in — open, focused and in view.
 *
 * 📌 EXTRACTED RATHER THAN COPIED, and the file already says why in the comment m5e left here:
 * *"A fix that lives in one call site is a fix that the next call site does not get."* — written
 * about `wbSave` knowing the two-frame scroll rule three weeks before ✚ Add entry was written
 * without it. Import is the third call site and inherits all of it by construction.
 *
 * `select` is true only for ✚ Add entry, whose new row holds placeholder text that typing should
 * replace. An imported entry holds user-authored text, so selecting it would arm a keystroke to
 * delete the imported content.
 *
 * @param {string} kind
 * @param {string} docId
 * @param {number} revision
 * @param {boolean} select
 */
async function wbLandOnNewEntry(kind, docId, revision, select) {
  await wbLoadLib(kind);
  // 🔴 `scrollToRow: false` — THE TWO SCROLLS WERE FIGHTING AND THE SMOOTH ONE WON.
  // `wbOpen` normally puts the library ROW a third of the way down the page, smoothly. Adding an
  // entry has a different destination — the new entry, at the far end of the book — and an
  // instant scroll layered on top of a running `behavior:'smooth'` animation does not win: it
  // only moves where that animation is easing FROM. Measured on a 26-entry book: the viewport
  // jumped correctly to 7914px and was then dragged back to 33px over the next 1.5 seconds, one
  // frame at a time.
  await wbOpen(kind, docId, revision, { scrollToRow: false });
  // Put him in the new box — with the placeholder selected when there is one, so typing replaces
  // it. The entry is last in the list because that is the order it was appended in.
  const boxes = /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbfield');
  const last = boxes[boxes.length - 1];
  if (last) {
    const ta = /** @type {HTMLTextAreaElement|null} */ (last.querySelector('.wbtext'));
    last.classList.remove('wbfold', 'wbhide'); // never land him on a row he cannot see
    // 🔴 §9a.31 — AND THE ACCORDION, WHICH IS THE THIRD WAY THIS ROW CAN BE INVISIBLE. A new
    // entry is appended at the far end of a book whose other rows are already shut, and
    // `wbShutInit` restores the layout it knew — which cannot include an index that did not exist
    // a moment ago, so the new row is born collapsed. `.focus()` on a `display:none` textarea
    // silently does nothing: the caret goes nowhere and the placeholder is never selected, which
    // is §9a.24's complaint arriving by a new route. Through `wbShutToggle` so `openRows` records
    // it and the row is still open after the save that follows.
    wbShutToggle(kind, last, false);
    // 🔴 m5e / §9a.24 — AFTER A FRAME, so scrolling uses the rebuilt layout.
    // `wbOpen` has just rebuilt the whole field list from `innerHTML`, so at this point in the
    // turn the document still has its OLD height — a synchronous `scrollIntoView` is computed
    // against a layout that no longer describes the page, and the browser settles wherever that
    // stale arithmetic pointed, which on a long book is the top.
    //
    // `wbSave` uses the same `rAF` pattern because the height only exists once the new fields have
    // laid out. m4z wrote ✚ Add entry in the
    // same shape three weeks later and did not inherit the lesson. 📌 A fix that lives in one
    // call site is a fix that the next call site does not get.
    //
    // ⚠️ TWO frames, not one. The first is when layout exists; the second survives a reflow
    // landing in between — the roster above the editor was rebuilt by `wbLoadLib` on the line
    // above, and anything that settles a frame late would otherwise slide the box back off screen.
    if (ta)
      requestAnimationFrame(() => {
        ta.focus();
        if (select) ta.select();
        last.scrollIntoView({ block: 'center' });
        requestAnimationFrame(() => last.scrollIntoView({ block: 'center' }));
      });
  }
}

// ── ⬆ Import entry — 7.3.20 ──────────────────────────────────────────────────────────────────
//
// Import a JSON entry from a file and let the server validate and add it to the open book.
// 🔴 THE FILE IS PARSED BY THE SERVER, NOT HERE. It would be two lines to `JSON.parse` it in the
// browser and POST the object — and then the browser would be the authority on what counts as an
// entry, which puts the shape rules in the one place that cannot enforce them. The route runs the
// same `check_document` pass the other four import doors run, renumbers the uid against the book
// it is merging into, and mints the revision; this function's whole job is to hand it the bytes
// and say what came back.
//
// 🔴 AND THE uid IT ARRIVED WITH IS NOT THE uid IT LANDS ON. The renumbering is REPORTED rather
// than silent, because "18 → 3" is the one thing about this operation he cannot see anywhere else.
/**
 * @param {string} kind
 * @param {File} file
 */
export async function wbImportEntry(kind, file) {
  const st = wbState(kind);
  if (!st.doc || !st.rev) {
    wbSay(kind, 'Open a World Book first.', true);
    return;
  }
  // Pinned before the upload for `wbAddEntry`'s reason: this is a WRITE, the roster stays
  // clickable while the file goes up, and a merge must not land on whatever document is open when
  // it finishes.
  const seq = wbGen(kind),
    docId = st.doc.id,
    revN = st.rev.n;
  wbSay(kind, 'reading ' + file.name + '…', 'busy');
  const fd = new FormData();
  fd.append('file', file);
  let r, j;
  try {
    // ⚠️ Raw `fetch`, not `jpost`: this is multipart, and `jpost` sets a JSON content type. Same
    // reason `wbImport` does it by hand one screen up.
    r = await fetch('/wbedit/documents/' + encodeURIComponent(docId) + '/entry/import' + '?revision=' + revN, { method: 'POST', body: fd });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    wbSay(kind, 'could not reach the server.', 'bad');
    return;
  }
  if (!r.ok) {
    wbSay(
      kind,
      r.status === 423
        ? 'Vocalis is locked — log in first.'
        : // 409, for ✚ Add entry's reason — the file picker is a dialog too (revision-conflict guard).
          r.status === 409
          ? 'this book moved to revision ' +
            (j.latest ?? '?') +
            ' while the file picker was open — nothing was imported. Reopen it and try again.'
          : j.error || 'the import failed (HTTP ' + r.status + ')',
      true,
    );
    return;
  }
  // 🔴 THE ENTRY WAS IMPORTED — SAY SO, AND STOP THE SPINNER (revision-conflict guard). A bare return
  // here left "reading <file>…" spinning over whichever document he switched to, while the
  // revision it is not mentioning had already been minted.
  if (wbStale(kind, seq)) {
    wbSay(kind, 'imported into the book you were on — it is revision ' + (j.revision == null ? '?' : j.revision) + ' now.', 'ok');
    return;
  }
  await wbLandOnNewEntry(kind, docId, j.revision, false);
  const n = j.added || 0;
  // Only the ones that actually moved. A file whose uid was already free reports nothing, because
  // "uid 3 → 3" is noise that trains him to skip the part that matters.
  const moved = /** @type {{from?:number, to?:number}[]} */ (j.uids || []).filter(u => u && u.from != null && u.from !== u.to);
  wbSay(
    kind,
    'imported ' +
      n +
      ' entr' +
      (n === 1 ? 'y' : 'ies') +
      ' as revision ' +
      j.revision +
      (moved.length
        ? ' · uid ' + moved.map(u => u.from + ' → ' + u.to).join(', ') + ' (renumbered, so nothing already in this book was overwritten)'
        : '') +
      (j.inert
        ? ' · ' +
          j.inert +
          (j.inert === 1 ? ' has' : ' have') +
          ' no keywords and will never fire — give ' +
          (j.inert === 1 ? 'it' : 'them') +
          ' one, or set always injected'
        : '') +
      (j.placeholders
        ? ' · ' + j.placeholders + ' arrived with no text and hold' + (j.placeholders === 1 ? 's' : '') + ' the placeholder'
        : '') +
      ' — press ⬆ Save to SillyTavern when you want it over there.',
    'ok',
  );
}

// ── ⇊ Fix positions — 9.4 ────────────────────────────────────────────────────────────────────
//
// WHAT IT IS FOR, because the button's own words cannot carry it: SillyTavern puts World Info near
// the TOP of the prompt, the set of active entries changes every turn, and a KV cache can only
// reuse tokens up to the first byte that differs — so everything below the block is recomputed
// every turn. Moving stable entries earlier can preserve more reusable prompt tokens. The
// arithmetic and the fork citations are in `src/wbedit/formats/depthfix.py`.
//
// 🔴 THE PREVIEW IS THE POINT, NOT A COURTESY. This rewrites fields across a book, so showing the
// number that will move before commit makes that a
// decision rather than a surprise, and it is why the button opens a dialog instead of just doing
// it. Counts only: nothing here renders an entry's title, keywords or text, and the routes are
// built so it could not if it tried.
//
// 🔴 AND THE COUNT LINE IS LIVE, FROM NUMBERS THE SERVER COMPUTED. The two extra ticks change how
// many entries move, so a static "31 will move" would be a lie the moment one is ticked. All four
// combinations arrive in the preview response — `moving.base` / `.examples` / `.unstable` /
// `.both` — rather than the browser adding `offer_examples` to `moving`, which is wrong whenever
// an entry qualifies under both and wrong silently.
/** @param {string} kind */
export async function wbFixDepths(kind) {
  const st = wbState(kind);
  if (!st.doc || !st.rev) {
    wbSay(kind, 'Open a World Book first.', true);
    return;
  }
  // Pinned before the dialog for `wbAddEntry`'s reason, and this one is a WRITE over most of the
  // book: a rewrite must not land on whichever document happens to be open when he presses the
  // button.
  //
  // ⚠️ **AND THE PIN IS NOT THE PROTECTION — the modal blocks page interaction, while the generation guard protects stale results.** An earlier version of this comment
  // said "the roster stays clickable while he reads the counts", which is false: `#overlay` is
  // `position:fixed; inset:0`, so the dialog covers the page and `wbStale` after it is nearly
  // unreachable through the UI. What the pin actually defends against is the head MOVING under
  // the dialog — another tab, or a `/pair/documents` push from a SillyTavern tab — and `wbStale`
  // cannot see that, because it is a per-pane counter bumped only by `wbOpen` in THIS tab. The
  // server's `require_head` is what makes that safe; the 409 branch below is its other half.
  const seq = wbGen(kind),
    docId = st.doc.id,
    revN = st.rev.n;
  wbSay(kind, 'looking at where the entries sit…', 'busy');
  /** @type {any} */
  let p;
  try {
    p = await jget('/wbedit/documents/' + encodeURIComponent(docId) + '/depths?revision=' + revN);
  } catch (e) {
    const ex = /** @type {ErrLike} */ (e);
    wbSay(
      kind,
      ex.status === 423
        ? 'Vocalis is locked — log in first.'
        : (ex.body && /** @type {string} */ (ex.body.error)) || 'could not read this book',
      true,
    );
    return;
  }
  // Nothing was written here, so there is nothing to report — but the busy spinner set before
  // the fetch has no auto-clear, so it has to be put out explicitly (spinner cleanup).
  if (wbStale(kind, seq)) {
    wbHush(kind);
    return;
  }
  // 🔴 GUARDED LIKE ITS NEIGHBORS — validate the response shape before reading its fields. `p.reasons`, `p.buckets` and `p.leaving`
  // are all defended and this one was not, so a response without `moving` threw a raw
  // `Cannot read properties of undefined` onto the message line where every other failure in
  // this function produces a sentence.
  if (!p || !p.moving || typeof p.moving.both !== 'number') {
    wbSay(kind, 'the server did not answer with a preview of this book — nothing was changed.', true);
    return;
  }
  if (!p.moving.both) {
    // 🔴 A DIALOG, NOT THE MESSAGE LINE — 9.5.4, AND THIS REVERSES A DELIBERATE CHOICE. The note
    // here used to prefer a message line because a modal adds a dismissal step. That reasoning
    // ignored that a no-op click still needs a visible acknowledgment.
    //
    // ⚠️ AND THE MESSAGE LINE WAS THE WRONG PLACE TWICE OVER: the strip lived in the library
    // header while this button lives in the editor's toolbar, which `wbPlaceEditor` grafts into
    // a roster row — so on a book part-way down the list the answer rendered off the top of the
    // window. `wbMirror` fixes the address; a press that changes nothing still deserves a visible
    // reply because "nothing happened" and "the button is broken" look identical.
    //
    // 📌 ONE BUTTON, AND IT SAYS OK. There is nothing to cancel — the book is already right — so
    // offering Cancel/Confirm would invent a decision out of an acknowledgment.
    wbHush(kind);
    // 🔴 NOT `num` — IT IS A `const` DECLARED BELOW THIS RETURN, so reading it here is a temporal
    // dead zone `ReferenceError` at the exact moment the book is fine and the dialog is the only
    // thing this branch does. The same coercion, inline: a count that is not a number is not a
    // count, so it is replaced rather than escaped.
    const nTotal = Number.isFinite(Number(p.total)) ? Number(p.total) : 0;
    await modal(
      'Nothing to fix',
      '<div>Every entry in this book is already at <b>At depth</b>, or sitting somewhere it was ' +
        "deliberately placed — the author's note positions and Outlet entries are not this " +
        "button's business.</div>" +
        '<div class="small muted" style="margin-top:10px">' +
        '<b>' +
        nTotal +
        '</b> ' +
        (nTotal === 1 ? 'entry' : 'entries') +
        ' checked, none of them above the chat history. This book is not costing you a reprocess, ' +
        'and nothing was changed.</div>',
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    return;
  }

  // 🔴 THE BUSY LINE IS CLEARED BEFORE THE DIALOG OPENS, AND A SCREENSHOT IS WHAT FOUND THIS.
  // `wbSay(…, 'busy')` above sets "looking at where the entries sit…" with a running spinner, and
  // nothing cleared it — so the dialog opened over a message line still claiming to be working on
  // the thing it had already finished. Every assertion in the browser spec passed: they read the
  // dialog and the counts, and none of them looks at the strip behind it. A spinner that outlives
  // its operation is the same class of lie as a report about a run that has not landed.
  wbHush(kind);
  const id = 'wbfd_' + Math.random().toString(36).slice(2, 9);
  const plural = /** @param {number} n */ n => (n === 1 ? 'entry' : 'entries');
  // 🔴 EVERY SERVER VALUE BELOW GOES THROUGH THIS — escape values before inserting modal HTML. `modal()` assigns its body
  // with `innerHTML`, so the string is an HTML sink, and three of these land inside `"`-quoted
  // ATTRIBUTES on the depth input. They are all counts today, which is why nothing was on fire;
  // `esc()` would be the weaker answer anyway. A count that is not a number is not a count, so it
  // is replaced with one rather than escaped — the same rule the two lines below already apply to
  // `reasons`, stated once and applied everywhere instead of per site.
  const num = /** @param {any} v @param {number} dflt @returns {number} */ (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);
  const total = num(p.total, 0),
    minDepth = num(p.min_depth, 0),
    maxDepth = num(p.max_depth, 9999),
    defDepth = num(p.default_depth, 4);
  // How many entries a tick would ADD, given the OTHER tick's state — the server's per-combination
  // figure, falling back to the flat pair an older server sends. `key` is the combination the
  // count is read from, which is always the one with THIS tick off: a tick that is already on has
  // nothing left to offer.
  const offerAt = /** @param {string} key @param {'examples'|'unstable'} which @returns {number} */ (key, which) => {
    const o = p.offers && p.offers[key];
    if (o && Number.isFinite(Number(o[which]))) return Number(o[which]);
    return num(which === 'examples' ? p.offer_examples : p.offer_unstable, 0);
  };
  // The reasons the always-injected ones flicker, in the server's words. A fixed vocabulary plus
  // a number, `esc`'d anyway — the rule is that nothing off a document is ever trusted, and the
  // next person to touch this route may well widen what it reports.
  const reasons = Object.keys(p.reasons || {})
    .map(r => esc(r))
    .join(', ');
  const body =
    '<div class="small muted" style="margin-bottom:10px">' +
    'SillyTavern puts World Info near the <b>top</b> of the prompt, and a prompt cache is only good up to the first byte that changes. ' +
    'An entry that comes and goes up there costs a full reprocess of everything below it — every turn. ' +
    'Moving them to <b>At depth</b> puts that change near the end instead.' +
    '</div>' +
    '<div style="margin-bottom:8px">' +
    '<b>' +
    total +
    '</b> ' +
    plural(total) +
    ' in this book · <b id="' +
    id +
    '_n">' +
    num(p.moving.base, 0) +
    '</b> <span id="' +
    id +
    '_w">will move</span>' +
    '</div>' +
    // 🔴 THE THIRD NUMBER. The diagnosis handoff's preview requirement is "total entries, how many
    // would move, how many would be LEFT ALONE", and the first build showed two of the three
    // because the third is `total - moving` and derivable. Derivable is not shown: the whole point
    // of a preview over a book he has spent months on is that he does not have to do arithmetic to
    // find out what this button is about to leave behind. The breakdown under it answers the
    // question the bare count invites — left alone WHY — and it is the server's, per tick
    // combination, for the same reason the moving count is.
    '<div class="small muted" id="' +
    id +
    '_left" style="margin-bottom:10px"></div>' +
    '<label class="small" style="display:flex;align-items:center;gap:6px;margin-bottom:10px">' +
    '<span>move them to depth</span>' +
    '<input type="number" id="' +
    id +
    '_d" class="filter" style="width:5em" min="' +
    minDepth +
    '" max="' +
    maxDepth +
    '" value="' +
    defDepth +
    '">' +
    '<span class="muted">messages back from the end of the chat</span>' +
    '</label>' +
    // 🔴 THE COUNTS ON THESE TWO LABELS ARE REPAINTED, NOT FROZEN — derive the labels from the current selection. The one
    // beside "always-injected" DEPENDS ON THE OTHER TICK: an always-injected entry that flickers
    // AND sits at an example position is counted under the examples offer while that box is off,
    // and moves into this one the moment it goes on. Rendering it once from the base plan meant
    // ticking "examples" jumped the headline count by four while the label under it still said
    // two — two numbers in one dialog disagreeing, which is the exact failure the per-combination
    // `moving` map exists to prevent. `_ec` / `_uc` are what `repaint` writes.
    (offerAt('base', 'examples')
      ? '<label class="small" style="display:flex;align-items:start;gap:6px;margin-bottom:6px">' +
        '<input type="checkbox" id="' +
        id +
        '_e" style="margin-top:3px">' +
        '<span>also move the <b id="' +
        id +
        '_ec">' +
        offerAt('base', 'examples') +
        '</b> at before/after example messages — those sit above the whole chat history too, ' +
        'so they do the same damage. Off by default because an entry parked there was usually put there on purpose.</span>' +
        '</label>'
      : '') +
    (offerAt('base', 'unstable') || offerAt('examples', 'unstable')
      ? '<label class="small" style="display:flex;align-items:start;gap:6px;margin-bottom:6px">' +
        '<input type="checkbox" id="' +
        id +
        '_u" style="margin-top:3px">' +
        '<span>also move <b id="' +
        id +
        '_uc">' +
        offerAt('base', 'unstable') +
        '</b> always-injected (🔵) <span id="' +
        id +
        '_up">' +
        plural(offerAt('base', 'unstable')) +
        '</span> that do <b>not</b> fire every turn' +
        (reasons ? ' (' + reasons + ')' : '') +
        ' — a 🔵 entry that flickers costs exactly as much as a keyword one. Off by default because it changes where they land in the prompt.</span>' +
        '</label>'
      : '') +
    '<div class="small muted" style="margin-top:10px">' +
    'Only <b>position</b>, <b>depth</b> and <b>role</b> are written — text, keywords and order are left exactly as they are, ' +
    'and the result is checked field by field against this revision before anything is saved. ' +
    'This revision stays in the picker, so ↺ Roll back undoes the whole thing.' +
    '</div>';

  // 🔴 NOT AWAITED YET, AND THAT IS DELIBERATE. `modal` does all of its DOM work synchronously
  // inside the Promise executor, so the inputs exist the moment it returns — which is what lets
  // the count line be wired before he can touch anything. Awaiting first would mean the dialog is
  // already gone by the time we could reach into it.
  const answer = modal('Fix World Book positions', body, [
    { label: 'Cancel', value: 0 },
    { label: 'Fix positions', class: 'primary', value: 1 },
  ]);
  const nEl = document.getElementById(id + '_n');
  const wEl = document.getElementById(id + '_w');
  const eEl = /** @type {HTMLInputElement|null} */ (document.getElementById(id + '_e'));
  const uEl = /** @type {HTMLInputElement|null} */ (document.getElementById(id + '_u'));
  const ecEl = document.getElementById(id + '_ec');
  const ucEl = document.getElementById(id + '_uc');
  const upEl = document.getElementById(id + '_up');
  const leftEl = document.getElementById(id + '_left');
// The primary button is part of the count line. Zero is reachable with the
  // dialog open (a book whose only candidates are the offered ones starts at base 0), and the
  // line already said "nothing to do" while the button beside it stayed armed. Pressing it POSTed,
// the route returned 400, contradicting the dialog's ready-to-apply state.
  // A control whose only outcome is a refusal is the §9a.28 dead control, one dialog in.
  const okBtn = /** @type {HTMLButtonElement|null} */ (document.querySelector('#mActs button.primary'));
  const repaint = () => {
    const e = !!(eEl && eEl.checked),
      u = !!(uEl && uEl.checked);
    const key = e && u ? 'both' : e ? 'examples' : u ? 'unstable' : 'base';
    const n = num(p.moving[key], 0);
    if (nEl) nEl.textContent = String(n);
    if (okBtn) okBtn.disabled = n === 0;
    // Each label shows what ITS tick would add from here, which is the offer counted in the plan
    // with that tick off and the other one as it stands.
    if (ecEl) ecEl.textContent = String(offerAt(u ? 'unstable' : 'base', 'examples'));
    if (ucEl) ucEl.textContent = String(offerAt(e ? 'examples' : 'base', 'unstable'));
    if (upEl) upEl.textContent = plural(offerAt(e ? 'examples' : 'base', 'unstable'));
    // "will move" reads wrong at zero, and zero is reachable: unticking is not the only way in —
    // a book whose only movable entries are the offered ones starts at base 0.
    if (wEl) wEl.textContent = n === 1 ? 'will move' : n === 0 ? 'will move — nothing to do' : 'will move';
    if (leftEl) {
      // 🔴 THE SERVER'S NUMBER, NOT `p.total - n`. They agree today, and the subtraction is the
      // sort of thing that keeps agreeing right up until a rule is added that puts an entry in
      // neither column. One authority decides what moves and one decides what does not, and it
      // is the same one.
      const left = p.leaving ? num(p.leaving[key], total - n) : total - n;
      const b = (p.buckets && p.buckets[key]) || {};
      // Only the buckets that actually hold something — a breakdown listing three zeroes is
      // noise on the common book, and the §9a.28 rule about controls applies to prose too.
      const why = [
        b.stable ? b.stable + ' always injected and steady' : '',
        b.at_depth ? b.at_depth + ' already at a depth' : '',
        b.placed ? b.placed + ' placed somewhere deliberate' : '',
        b.offered ? b.offered + ' offered above, not ticked' : '',
      ].filter(Boolean);
      leftEl.textContent =
        left === 0
          ? 'nothing is left behind — every entry in this book moves.'
          : left + ' left alone' + (why.length ? ' — ' + why.join(', ') : '') + '.';
    }
  };
  if (eEl) eEl.addEventListener('change', repaint);
  if (uEl) uEl.addEventListener('change', repaint);
  // 🔴 ONCE, NOW. The moving count is rendered inline in the markup above, so it is correct before
  // anything is clicked; the left-alone line is not, and `repaint` was reachable ONLY through a
  // checkbox `change`. On a book with no extras to offer there are no checkboxes at all, so it
  // could never fire — the line would have been empty for the whole life of the dialog on most of
  // his books. Rendering half the summary inline and half in a handler is what made that possible;
  // this call is what closes it.
  repaint();
  const depthEl = /** @type {HTMLInputElement|null} */ (document.getElementById(id + '_d'));
  // Read INSIDE this function, before `modal` tears the overlay down — `wbAskName` says why.
  /** @type {{depth:number, examples:boolean, unstable:boolean}} */
  const chosen = { depth: defDepth, examples: false, unstable: false };
  // 🔴 AN UNREADABLE BOX IS REFUSED, NOT SUBSTITUTED — validate the requested depth. `<input type="number">`
  // reports `.value === ''` for BOTH an empty box and one holding "4abc", so the old
  // `value === '' ? default : Number(value)` silently applied depth 4 to every moved entry after
  // he typed something else. That is exactly the silent substitution `_depth_arg` refuses to make
  // on the server, performed on the client instead. `validity.badInput` is what tells the two
  // apart; NaN carries the refusal down to the guard before the POST.
  const capture = () => {
    if (depthEl)
      chosen.depth = depthEl.validity && depthEl.validity.badInput ? NaN : depthEl.value === '' ? defDepth : Number(depthEl.value);
    chosen.examples = !!(eEl && eEl.checked);
    chosen.unstable = !!(uEl && uEl.checked);
  };
  if (depthEl) depthEl.addEventListener('input', capture);
  if (eEl) eEl.addEventListener('change', capture);
  if (uEl) uEl.addEventListener('change', capture);
  const ok = await answer;
  capture();
  if (!ok) {
    wbSay(kind, 'nothing was changed.', 'ok');
    return;
  }
  if (wbStale(kind, seq)) {
    wbSay(kind, 'Not changed — you moved to another document.', true);
    return;
  }
  // The client half of `_depth_arg`'s rule: refuse rather than send a number he did not type.
  if (!Number.isInteger(chosen.depth)) {
    wbSay(kind, 'that depth is not a whole number — nothing was changed.', true);
    return;
  }
  wbSay(kind, 'moving the entries…', 'busy');
  let r;
  try {
    r = await jpost('/wbedit/documents/' + encodeURIComponent(docId) + '/depths' + '?revision=' + revN, chosen);
  } catch (e) {
    const ex = /** @type {ErrLike} */ (e);
    wbSay(
      kind,
      ex.status === 423
        ? 'Vocalis is locked — log in first.'
        : // 🔴 409 IS THE ONE THAT NEEDS ITS OWN SENTENCE — the base revision changed while the dialog was open. The revision was
          // pinned before a dialog he can read for minutes, and the server now refuses to build a
          // new head off a base that has stopped being the head. The route's own message is about
          // revision numbers; what he needs to know is that his book moved and nothing was lost.
          ex.status === 409
          ? 'this book changed while the dialog was open — nothing was moved. Reopening it at revision ' +
            num(ex.body && /** @type {any} */ (ex.body).latest, revN) +
            ' so you can try again.'
          : (ex.body && /** @type {string} */ (ex.body.error)) || 'the entries were not moved',
      true,
    );
    if (ex.status === 409 && !wbStale(kind, seq)) {
      await wbLoadLib(kind);
      await wbOpen(kind, docId, undefined, { scrollToRow: false });
    }
    return;
  }
  // 🔴 THE WRITE LANDED, SO THE SPINNER MUST NOT SURVIVE THE RETURN — clear busy state after the write. A bare
  // `return` here left "moving the entries…" spinning forever over a DIFFERENT document: the
  // `'busy'` tone is the one `wbSay` gives no 6-second auto-clear, and the revision had already
  // been minted, so the pane was simultaneously claiming to be working and hiding the fact that
  // the work was done. Same class as the stale spinner a screenshot caught before the dialog.
  if (wbStale(kind, seq)) {
    wbSay(
      kind,
      'moved ' +
        num(r.moved, 0) +
        ' ' +
        plural(num(r.moved, 0)) +
        ' in the book you were on — it is revision ' +
        num(r.revision, 0) +
        ' now.',
      'ok',
    );
    return;
  }
  // Reopen at the new revision. 🔴 NOT `wbLandOnNewEntry` — that one scrolls to the LAST entry
  // because its two callers had just appended one. Nothing was appended here, so landing him at
  // the far end of a 110-entry book would be a jump with no destination.
  await wbLoadLib(kind);
  await wbOpen(kind, docId, r.revision, { scrollToRow: false });
  wbSay(
    kind,
    'moved ' +
      r.moved +
      ' ' +
      plural(r.moved) +
      ' to depth ' +
      r.depth +
      ' as revision ' +
      r.revision +
      (r.left_stable
        ? ' · ' + r.left_stable + ' always-injected left at the top (they are steady, so they cost nothing after the first turn)'
        : '') +
      ' — press ⬆ Save to SillyTavern when you want it over there.',
    'ok',
  );
}

// ── §9a.31: the entry accordion ──────────────────────────────────────────────────────────────
//
// A 110-entry book paints 110 textareas sized `clamp(3, chars/90, 18)` rows — thousands of rows of
// DOM before the first entry is useful. The ⚙ settings fold (m5g) is collapsed,
// but that hides the SETTINGS, not the body, so it did nothing for the height.
//
// 🔴 IT IS A VIEW OPERATION AND IT CHANGES NOTHING ELSE. §9a.21 is the record of I13 quietly
// becoming a rule about eyesight: a hidden field that stops being sent is a pass that silently
// does less than it says. So a shut entry is still ticked, still scanned by Find, still read by
// `wbSetEdits`, still counted by the preflight, and still saved. The ONLY thing this touches is a
// class on the row. Nothing here may ever consult `.wbshut`.

/** Which entry rows are open, per pane. Same shape and same lifetime rule as m5g's `st.setOpen`. */

/** True when the open document has at least one entry — i.e. when an accordion exists at all. */

/** Both toolbar buttons. `on` true shuts everything, false opens everything. */

// §9a.30 — the spinner and the disable are ONE change and they wrap the whole request. `btn` is
// whichever of the two §9a.27 triggers was pressed; it is optional, so any future caller that
// saves without a button still gets the double-click guard.
/**
 * @param {string} kind
 * @param {Element|null} [btn] - whichever of the two §9a.27 triggers was pressed. `Element`
 *   because that is what `wbSaveBusy` (edit.js) takes; callers off a click event cast
 *   `ev.currentTarget` (statically `EventTarget|null`) at the call site — see `wire.js`.
 */
export async function wbSaveEdits(kind, btn) {
  wbSaveBusy(kind, true, btn);
  try {
    return await wbSaveApply(kind);
  } finally {
    // 🔴 `finally`, so a throw restores the button too. The 423-from-a-locked-vault path is the
    // one that matters: a control left spinning after a failure is worse than no spinner, because
    // it says the save is still going.
    wbSaveBusy(kind, false, btn);
  }
}

/** @param {string} kind */
async function wbSaveApply(kind) {
  const st = wbState(kind),
    edits = [];
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbtext').forEach(ta => {
    const i = +(/** @type {string} */ (/** @type {HTMLTextAreaElement} */ (ta).dataset.i));
    const original = wbGetAt(st.rev.content, st.fields[i].locator);
    if (/** @type {HTMLTextAreaElement} */ (ta).value !== original)
      edits.push({ locator: st.fields[i].locator, text: /** @type {HTMLTextAreaElement} */ (ta).value, label: st.fields[i].label });
  });
  // 🔴 m5g / §9a.26 — ONE SAVE, ONE REVISION. The settings ride in the same request as the prose:
  // two requests would mint revision 3 and then revision 4 for one press of one button, and half a
  // save is what a rollback then has to undo twice. `text` and `value` are the two shapes the edit
  // route accepts and it applies them together.
  edits.push(...wbSetEdits(kind));
  if (!edits.length) {
    wbSay(kind, 'nothing changed');
    return;
  }
  let r;
  try {
    r = await jpost('/wbedit/documents/' + encodeURIComponent(st.doc.id) + '/edit', {
      edits,
      revision: st.rev.n,
    });
  } catch (e) {
    const ex = /** @type {ErrLike} */ (e);
    // 🔴 409 = THE DOCUMENT CHANGED WHILE EDITING. A second
    // tab, an ST re-import, or a pass applied from the review queue. The typing is still in the
    // textareas and the drafts are still on the server, so nothing is lost by stopping here —
    // and stopping is the only honest answer, because saving would rebuild the head from a base
    // that is no longer the head and take the intervening revisions with it.
    if (ex && ex.status === 409) {
      const to = ex.body && ex.body.latest;
      wbSay(
        kind,
        `Someone else saved this document while you were editing — it is now at ` +
          `revision ${to}. Your text is still here and still stored. Reopen it to see ` +
          `their version, or copy your changes out first.`,
        true,
      );
      return;
    }
    // 🔴 §9a.29a — REFUSED because an entry would be stored that SillyTavern can never fire.
    // Nothing was written and nothing is lost: his typing is still in the boxes and the drafts
    // are still on the server. Mark the offenders, open their settings so the empty Keywords box
    // is on screen, and put the first one in front of him — a refusal he has to hunt for is a
    // refusal that reads as a broken button.
    if (ex && ex.status === 422 && ex.body && ex.body.error === 'entries_without_keywords') {
      wbMarkKeyless(kind, ex.body.entries || []);
      wbSay(kind, (ex.body && ex.body.message) || 'some entries have no keywords', true);
      return;
    }
    // ⚠️ AND EVERY OTHER FAILURE GETS SAID OUT LOUD (§5.7). This handler dropped its promise, so
    // a 423 from a locked vault or a dead server produced an unhandled rejection and NO message
    // anywhere: the Save bar stayed up, the button looked dead, and nothing on screen explained
    // it. That is a worse failure than the one the spinner item (§9a.30) is about.
    wbSay(kind, (ex && ex.message) || 'could not save', true);
    return;
  }
  // §9a.15 — the server drops the draft file as part of the same request; this is the in-memory
  // mirror of that. Leaving it populated would make the next blur think it had already stashed
  // the new text and skip the PUT, so the first edit after a save would not be protected.
  st.draftAt = {};
  await wbLoadLib(kind);
  // 🔴 THE MESSAGE COMES AFTER THE RE-OPEN, AND THAT ORDERING IS THE WHOLE FIX. `wbOpen` rebuilds
  // the pane, and it used to land on top of a message written before it — so the one record the
  // save left behind was a gray line that erased itself six seconds later, over a page that had
  // just jumped. The success message must be written after the re-open so it remains visible.
  const y = window.scrollY;
  await wbOpen(kind, st.doc.id);
  // 🔴 AND THE SCROLL POSITION IS PUT BACK. Rebuilding the field list collapses the document to
  // nothing for an instant, which is enough for the browser to forget the scroll position — so a save
  // made forty fields down threw away his place as its reward. Restored after a frame, because
  // the height only exists once the new fields have laid out.
  requestAnimationFrame(() => window.scrollTo(0, y));
  // 'ok' — green, and it STAYS until dismissed with the ✕ (m4m's terminal tone). A save is
  // exactly the event that must remain on screen.
  wbSay(kind, 'saved as revision ' + r.n, 'ok');
}

// ── the pass ─────────────────────────────────────────────────────────────
/**
 * @param {string} kind
 * @param {boolean} previewOnly
 */
export async function wbRun(kind, previewOnly) {
  const st = wbState(kind);
  const instruction = /** @type {HTMLTextAreaElement} */ (wbEl(kind, 'wbIns')).value.trim();
  if (!instruction) {
    wbSay(kind, 'write an instruction first', true);
    return;
  }
  let idx = wbTicked(kind);
  if (!idx.length) {
    wbSay(kind, 'tick at least one field', true);
    return;
  }
  // 🔴 The one-entry preview (§6.1.3): run against a SINGLE field and look before committing to
  // 35 minutes. Cheapest high-value affordance in the design. Which field is now HIS choice
  // (item 7) rather than "whichever happens to be first in document order".
  if (previewOnly) {
    const pick = /** @type {HTMLSelectElement} */ (wbEl(kind, 'wbPreviewPick'));
    const chosen = pick && pick.value !== '' ? +pick.value : idx[0];
    idx = idx.includes(chosen) ? [chosen] : idx.slice(0, 1);
  }

  const sel = /** @type {HTMLSelectElement} */ (wbEl(kind, 'wbInsPick'));
  let started;
  try {
    started = await jpost('/wbedit/documents/' + encodeURIComponent(st.doc.id) + '/pass', {
      instruction,
      revision: st.rev.n,
      locators: idx.map(i => st.fields[i].locator),
      instruction_id: sel.value || '',
    });
  } catch (e) {
    // 409 is I12 — one model is loaded, so one pass at a time. Say which one rather than
    // leaving him to guess why the button did nothing.
    wbSay(
      kind,
      /** @type {ErrLike} */ (e).status === 409
        ? 'A pass is already running. Wait for it, or stop it first.'
        : /** @type {ErrLike} */ (e).message || 'could not start the pass',
      true,
    );
    return;
  }
  st.pass = started;
  st.seen = new Set();
  /** @type {VEl} */ (wbEl(kind, 'wbProposals')).innerHTML = '';
  /** @type {VEl} */ (wbEl(kind, 'wbReview')).style.display = '';
  /** @type {VEl} */ (wbEl(kind, 'wbReviewCount')).textContent = '';
  /** @type {HTMLButtonElement} */ (wbEl(kind, 'wbRun')).disabled = true;
  /** @type {HTMLButtonElement} */ (wbEl(kind, 'wbPreview')).disabled = true;
  /** @type {VEl} */ (wbEl(kind, 'wbCancel')).style.display = '';
  wbLogStart(kind);
  wbStream(kind);
}
