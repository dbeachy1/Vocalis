// ui/folders.js — one level of virtual folders, one shape for every list in the app (8.9).
//
// One folder expands at a time. Its children appear directly below it while the remaining folders
// retain their order.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE WHOLE THING IS ONE FLAT ARRAY, AND THAT IS WHAT ONE LEVEL BUYS.
//
//     📁 Auditions        (3)
//     📁 Keepers          (12)   ← open
//          row
//          row
//     📁 Scratch          (5)
//     ─────────────────────────
//       row  (unfiled)
//
// Folders before, the open one's children, folders after, a divider, then the unfiled rows —
// built by concatenation. No tree, no recursion, no expand-state map, no depth, no indent
// arithmetic, and none of the guards a tree needs (cycle checks, move-into-your-own-descendant,
// orphan-subtree repair on delete). `one level` + `one open folder` is not a simplification of
// the feature; it IS the feature, and every line below is shorter because of it.
//
// ⚠️ IF NESTING IS EVER WANTED, IT PAYS FOR THOSE GUARDS THEN. Do not "just add a parent field".
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 SCOPE IS THE DATA, NOT THE PANEL — the server's rule, restated here because this is where
// it gets broken. Three panels render `/train/sources` and two render `/voiceswap/songs`; each
// passes the same scope string, so filing in one files in all of them. A panel that invents its
// own scope name would silently give one dataset two sets of folders.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 📌 PER-GROUP `favFirst` FALLS OUT OF PARTITIONING AND NEEDS NO CODE.
//
// A ★ currently floats to the top of a whole list, and a starred row inside a CLOSED folder has
// nowhere to float to — so with folders the star has to float within the open folder and within
// the unfiled block instead. Callers keep calling `favFirst` on the whole array exactly as they
// do today: `folderRows` below splits the rows with two `filter`s, and `filter` preserves input
// order, so a globally-star-first array is still star-first inside each group. The behavior
// changes; no caller does.

import { esc } from '../util/dom.js';
import { jget, jpost, jdel } from '../util/http.js';
import { modal, promptForName, confirmDelete } from './modal.js';
import { UIS } from '../util/uistate.js';

// scope -> [{id, name}], as last fetched. A cache, never the truth: every verb below re-fetches
// before it repaints, because the store on disk is what the next reader sees.
/** @type {Record<string, {id: string, name: string}[]>} */
const FOLDERS = {};

// scope -> {ref: folder_id}, from the same fetch. See `folderOfRef` for the ONE panel this is
// for and why every other panel must keep ignoring it.
/** @type {Record<string, Record<string, string>>} */
const ASSIGN = {};

/** @param {string} scope */
const openKey = scope => `vocalis-folder-open-${scope}`;

/**
 * The folder currently open in this scope, or `''` for none.
 * 📌 UI state, deliberately not in `folders.yaml`: which box you have open is not a property of
 * the filing, and putting it in the store would make one browser's navigation another's.
 * @param {string} scope
 * @returns {string}
 */
export const folderOpen = scope => UIS.getItem(openKey(scope)) || '';

/**
 * Open one folder, or close them all with `''`. Only one folder may be open at a time.
 * @param {string} scope
 * @param {string} fid
 */
export function setFolderOpen(scope, fid) {
  const cur = folderOpen(scope);
  const next = !fid || fid === cur ? '' : fid; // clicking the open one closes it
  try {
    UIS.setItem(openKey(scope), next);
  } catch {
    /* a non-persisted open folder is a cosmetic loss, never a reason to fail the click */
  }
  return next;
}

/**
 * This scope's folders, name-ordered, from the server. Caches into `FOLDERS`.
 * @param {string} scope
 * @returns {Promise<{id: string, name: string}[]>}
 */
export async function loadFolders(scope) {
  try {
    const d = await jget(`/folders/${encodeURIComponent(scope)}`);
    FOLDERS[scope] = d.folders || [];
    ASSIGN[scope] = d.assign || {};
  } catch {
    // 🔴 A LIST MUST STILL RENDER WHEN THE FOLDER ROUTE IS UNREACHABLE. Folders are an overlay
    // on a flat list; degrading to "no folders" gives you back exactly the pre-8.9 list, which
    // is a working page. Throwing here would take a whole tab down over a label.
    FOLDERS[scope] = FOLDERS[scope] || [];
    ASSIGN[scope] = ASSIGN[scope] || {};
  }
  return FOLDERS[scope];
}

/**
 * Which folder a ref is filed in, from the scope's assignment map.
 *
 * 🔴 ALMOST NO PANEL MAY CALL THIS. `folderRows` reads `row.folder`, stamped by the SERVER
 * (`folders.for_rows`), and that is the right answer everywhere the server holds the rows: it
 * knows the scope's stable key, and it stamps only rows it was handed, so a stale assignment is
 * invisible. Asking the map instead would be a second opinion about what a row IS.
 *
 * 🔴 THE EXCEPTION IS A PANEL WHOSE REF THE SERVER NEVER SEES. Voice Swap ▸ Sources merges five
 * stores into one list and composes four of the refs itself — `stems/<ref>`, `speech/<ref>`,
 * `pg/<ref>` — so no route can stamp them; those rows came back unfiled forever and
 * `⇥ Move selected here` looked like a dead button. This is not a second opinion there, it is
 * the SAME one: the composed ref is what `folderAssign` sends, and this reads it back under
 * exactly that string.
 *
 * ⚠️ A row the server DOES stamp must keep using `row.folder` even in that panel. Its four
 * feeder routes stamp under their OWN scopes, and a blanket lookup would be fine while a
 * blanket COPY of `.folder` would file a Voice Swap row under a `train_sources` folder id.
 *
 * @param {string} scope
 * @param {string} ref — the ref exactly as `folderAssign` would send it
 * @returns {string|null}
 */
export const folderOfRef = (scope, ref) => (ASSIGN[scope] || {})[ref] || null;

/** The cached folders for a scope, without a fetch. @param {string} scope */
export const foldersOf = scope => FOLDERS[scope] || [];

/** @param {string} scope @param {string} fid */
export const folderName = (scope, fid) => (foldersOf(scope).find(f => f.id === fid) || {}).name || '';

// 🔴 A REAL DISCRIMINATED UNION, NOT ONE OBJECT WITH EVERY FIELD OPTIONAL. The first cut typed
// the return as `{t: 'folder'|'item'|'gap', f?, row?, …}[]`, and `e.t === 'folder'` then narrowed
// NOTHING — `f` stayed optional in the true branch, so every caller had to assert it back. Three
// separate shapes let the checker do what the code already does at runtime.
/**
 * @typedef {{t: 'folder', f: {id: string, name: string}, open: boolean, n: number, target?: boolean}} FolderEntry
 * @typedef {{t: 'item', row: any, in?: string}} ItemEntry
 * @typedef {{t: 'gap'}} GapEntry
 * @typedef {FolderEntry|ItemEntry|GapEntry} FolderDisp
 */

/**
 * Build the display list for a panel.
 *
 * @param {string} scope
 * @param {any[]} rows — the rows the panel would have rendered, in the panel's OWN order
 *   (already filtered, already sorted, already `favFirst`ed — this does not reorder them).
 *   🔴 EACH ROW CARRIES `.folder` FROM THE SERVER, stamped by `folders.for_rows()`. This does
 *   not derive membership client-side, deliberately: the server already knows the scope's
 *   STABLE key for that row (for scenes `(h8, enhanced)`, never the display ref), and a second
 *   opinion about identity in the client is a second thing to get wrong. A panel whose payload
 *   is not stamped simply shows every row as unfiled, which is the pre-8.9 list.
 * @param {{query?: string}} o
 *   `query` is the panel's live filter text; when non-empty the folders COLLAPSE and every
 *   match renders flat, tagged with the folder it came from.
 * @returns {FolderDisp[]}
 */
export function folderRows(scope, rows, o) {
  const fs = foldersOf(scope);
  const q = (o.query || '').trim();

  // 🔴 A FILTER SEARCHES THE WHOLE SCOPE, ALWAYS — the hits render FLAT, out of their folders.
  // Explorer scopes search to the open folder; this must not, because a scoped search that
  // answers "Nothing matches" while the row sits in a closed folder is indistinguishable from
  // the row not existing. Opening a folder is navigation; typing in the box is search, and the
  // two stay orthogonal. `util/filter.js` has said "filters the DISPLAY ONLY" on nine panels
  // since 7.3-m1b; this is the same promise with folders in the way.
  //
  // 🔴 BUT THE FOLDER ROWS STAY, AS DESTINATIONS ONLY — no caret, no open action. Flattening
  // them away entirely was the first cut and it broke the workflow folders exist for: find the
  // six voices you want with a search, tick them, and file them. With nothing to press, that
  // ends in "clear the filter, lose your place, find them again". They keep their `⇥ Move
  // selected here` and their drop target; they just cannot be opened, because "open" and
  // "flattened" are not two states one list can be in at once.
  //
  // The count on a target row is MATCHES IN THAT FOLDER, not its total. During a search the
  // useful number is how much of what you are looking at is already filed there.
  if (q) {
    /** @type {FolderDisp[]} */
    const hits = [];
    /** @type {Record<string, number>} */
    const qn = {};
    for (const r of rows) if (r.folder) qn[r.folder] = (qn[r.folder] || 0) + 1;
    for (const f of fs) hits.push({ t: 'folder', f, open: false, n: qn[f.id] || 0, target: true });
    if (fs.length && rows.length) hits.push({ t: 'gap' });
    for (const row of rows) hits.push({ t: 'item', row, in: folderName(scope, row.folder) });
    return hits;
  }

  if (!fs.length) return rows.map(row => ({ t: /** @type {'item'} */ ('item'), row }));

  // Counted from THE LISTING, never from the assignment map — the map holds stale entries by
  // design, so a count taken from it shows (12) on a folder with four surviving items, wrong in
  // the one direction that sends you looking for what is missing.
  /** @type {Record<string, number>} */
  const n = {};
  for (const r of rows) if (r.folder) n[r.folder] = (n[r.folder] || 0) + 1;

  const open = folderOpen(scope);
  const mine = open ? rows.filter(r => r.folder === open) : [];
  // 🔴 A ROW STAMPED WITH A FOLDER THAT IS NOT ON SCREEN FALLS TO THE ROOT, NEVER OFF THE LIST.
  // `!r.folder` alone put a row whose `.folder` names a folder this scope no longer has into
  // NEITHER group: not in `mine` (that is only the OPEN folder) and not in `loose` — so it
  // rendered nowhere, with no folder row to open and no way to reach it. A vanished row is the
  // worst thing a list can do, and it is silent.
  //
  // 🔴 AND IT IS REACHABLE FROM ONE PAGE, not just from two tabs, because `FOLDERS` above is a
  // MODULE-level cache shared by every panel in a scope while `.folder` is stamped per PANEL.
  // Three panels render `train_sources` and two render `voiceswap_songs`: delete a folder in one
  // and `loadFolders` drops it for its siblings immediately, but their rows keep the stale stamp
  // until they refetch — which their own `reload` is never told to do. The sibling's next repaint
  // for any reason at all (a filter keystroke, a poll) then loses those rows until something
  // unrelated reloads it, which is how it arrives as a bug report about the wrong panel.
  //
  // The server agrees with this reading: `_clean` in src/folders.py drops an assignment naming a
  // folder that no longer exists, so unfiled is exactly what the next fetch would have said.
  const known = new Set(fs.map(f => f.id));
  const loose = rows.filter(r => !r.folder || !known.has(r.folder));

  /** @type {FolderDisp[]} */
  const out = [];
  for (const f of fs) {
    out.push({ t: 'folder', f, open: f.id === open, n: n[f.id] || 0 });
    // The children go DIRECTLY under their own folder row, and the folders after it carry on
    // below them, which is why this is a loop rather than a concatenation of three slices.
    if (f.id === open) for (const row of mine) out.push({ t: 'item', row });
  }
  // 🔴 THE DIVIDER IS THE ROOT, AND IT USED TO VANISH EXACTLY WHEN IT WAS NEEDED (8.9.12).
  // `data-folder=""` is the drop target that UN-files a row, and it was emitted only when
  // something was already unfiled — so once the last loose row was filed there was no way to drag
  // anything back out, and a list where everything is in a folder is precisely the state you get
  // to by using folders. The toolbar action (`folderAddButton`) is the
  // other half of the answer; this is the drag half.
  if (fs.length) out.push({ t: 'gap' });
  for (const row of loose) out.push({ t: 'item', row });
  return out;
}

/**
 * One folder header row.
 * @param {FolderEntry} e — an entry from `folderRows`
 * @param {{selectable?: boolean, keyAttr?: string}} [o] - `selectable` shows `⇥ Move selected
 *   here`. `keyAttr` names the `data-*` attribute a RECONCILED list keys its rows on (see below).
 *   ⚠️ ASCII HYPHEN, NOT AN EM-DASH, AFTER AN OPTIONAL `[param]`. TypeScript's JSDoc parser
 *   rejects `—` in that one position (TS1127) while accepting it everywhere else in a comment,
 *   which is why every optional param in this tree is written with `-`. Not a style preference.
 */
export function folderBar(e, o) {
  const f = e.f;
  const sel = o && o.selectable;
  // 🔴 A TARGET ROW IS NOT A BUTTON. While a filter is flattening the list a folder cannot be
  // opened, so rendering something that looks pressable and does nothing would be worse than
  // rendering less. It keeps its actions and its drop target; it loses the caret and the click.
  const head = e.target
    ? `<span class="vfoldname vftarget" title="Drop rows here, or tick some and press “⇥ Move selected here”">` +
      `<span class="vfcaret"> </span> <span class="vficon">📁</span> ` +
      `<span class="vfname">${esc(f.name)}</span> ` +
      `<span class="muted vfn">(${e.n || 0} here)</span></span>`
    : `<button class="vfoldname" data-fact="open" data-fid="${esc(f.id)}" ` +
      `title="${e.open ? 'Close this folder' : 'Open this folder'}">` +
      `<span class="vfcaret">${e.open ? '▾' : '▸'}</span> ` +
      `<span class="vficon">${e.open ? '📂' : '📁'}</span> ` +
      `<span class="vfname">${esc(f.name)}</span> ` +
      `<span class="muted vfn">(${e.n || 0})</span></button>`;
  // 🔴 `keyAttr` IS FOR THE RECONCILED LISTS, AND IT REPLACES `data-keep` RATHER THAN JOINING IT.
  // `ui/reconcile.js` removes any child that carries neither its key attribute nor `data-keep`,
  // and it treats everything with `data-keep` as FURNITURE — re-inserted at the top of the host,
  // ahead of every row. Furniture is exactly what a folder row is not: the whole interaction is
  // that an open folder's children sit between IT and the next folder, which a block pinned to
  // the top cannot express. Giving the row the list's own key attribute instead makes reconcile
  // order it like any other row, from the display array, and the in-place layout comes free.
  const ident = o && o.keyAttr ? ` data-${o.keyAttr}="${esc(f.id)}"` : ' data-keep';
  return (
    `<div class="vfolder${e.open ? ' open' : ''}" data-folder="${esc(f.id)}"${ident}>` +
    head +
    `<span class="vfacts">` +
    (sel
      ? `<button class="sm" data-fact="move" data-fid="${esc(f.id)}" ` +
        `title="Move every ticked row into this folder">⇥ Move selected here</button>`
      : '') +
    `<button class="sm" data-fact="rename" data-fid="${esc(f.id)}" title="Rename this folder">✎</button>` +
    `<button class="sm" data-fact="del" data-fid="${esc(f.id)}" ` +
    `title="Remove this folder — the items in it are KEPT and go back to the main list">✕</button>` +
    `</span></div>`
  );
}

/**
 * The divider between the folder block and the unfiled rows, and a drop target for un-filing.
 * @param {string} [keyAttr] - see `folderBar`: on a reconciled list the divider must be keyed as
 *   a row, not marked as `data-keep` furniture, or it is pinned to the top of the list.
 */
export const folderGap = keyAttr => `<div class="vfgap" data-folder=""${keyAttr ? ` data-${keyAttr}="__vfgap"` : ' data-keep'}></div>`;

/** Build reconciled rows with stable host keys so the host can update existing elements instead of replacing them.
 * * @param {FolderDisp[]} disp
 * @param {(row: any) => string} idOf - the id the host keys an ITEM row on
 * @returns {{id: string, e: FolderDisp}[]}
 */
export const folderReconcileRows = (disp, idOf) =>
  disp.map(e => ({ id: e.t === 'folder' ? e.f.id : e.t === 'gap' ? '__vfgap' : idOf(e.row), e }));

// ── the <table> variants ─────────────────────────────────────────────────────────────────
//
// 🔴 A `<div>` INSIDE A `<tbody>` IS DISCARDED BY THE PARSER, SILENTLY. Several of these lists
// are real tables (the Playground library, the Clips list), so a folder row there has to BE a
// row. Same markup, same data attributes, same handlers — only the box changes, which is why
// these wrap rather than duplicate.
/**
 * @param {FolderEntry} e
 * @param {number} cols — how many columns the panel's table has, for the `colspan`
 * @param {{selectable?: boolean}} [o]
 */
export const folderBarRow = (e, cols, o) =>
  `<tr class="vfolderrow" data-folder="${esc(e.f.id)}"><td colspan="${cols}">${folderBar(e, o)}</td></tr>`;

/** @param {number} cols */
export const folderGapRow = cols => `<tr class="vfgaprow" data-folder=""><td colspan="${cols}">${folderGap()}</td></tr>`;

/** Page items within the currently open folder; the folder list itself is not paged.
 * * @param {FolderDisp[]} disp
 * @param {number} page — zero-based; clamped, so a filter that shortens the list cannot strand you
 * @param {number} per
 * @returns {{rows: FolderDisp[], pages: number, page: number}}
 */
export function folderPage(disp, page, per) {
  const total = disp.reduce((n, e) => n + (e.t === 'item' ? 1 : 0), 0);
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(0, page | 0), pages - 1);
  const from = p * per;
  let i = -1;
  const rows = disp.filter(e => {
    if (e.t !== 'item') return true;
    i += 1;
    return i >= from && i < from + per;
  });
  return { rows, pages, page: p };
}

/**
 * The "in Keepers" tag shown beside a hit when a filter has flattened the list.
 * Without it a flat result set silently loses the one piece of information folders added.
 * @param {string} name
 */
export const folderTag = name => (name ? `<span class="vftag" title="In the folder “${esc(name)}”">📁 ${esc(name)}</span>` : '');

// ── ONE HOST, TWO LISTS (8.9.12) ─────────────────────────────────────────────────────────
//
// 🔴 `#vsPicker` RENDERS *SOURCES* OR *VOICES*, AND THEY ARE DIFFERENT SCOPES. `folderWire` and
// `folderWireDrag` are idempotent per HOST (`host.dataset.vfwired`), so a second call for the
// second scope silently does nothing — and wiring both anyway would be worse: a click on the
// folder row of whichever list is showing would fire BOTH handlers, and the one for the other
// scope would file voice names into `voiceswap_songs`.
//
// So `scope` may be a FUNCTION, resolved at the moment of the event. The panel that swaps its
// list under one host answers "which dataset am I looking at right now?" and everything else —
// the selection, the counts, the reload — was already a callback and branches the same way.
//
// 📌 A string scope stays a string scope. Nine of the ten panels have one list and pass one.
/** @param {string|(() => string)} scope @returns {string} */
const scopeOf = scope => (typeof scope === 'function' ? scope() : scope);

// ── the verbs ────────────────────────────────────────────────────────────────────────────
//
// Each returns true when something changed, so a caller can `if (await folderCreate(…)) reload()`
// without deciding what a cancel means. None of them repaints — the panel owns its own render.

/** @param {string} scope @returns {Promise<boolean>} */
export async function folderCreate(scope) {
  const name = await promptForName({
    title: 'New folder',
    blurb: 'Folders are labels — nothing moves on disk, and an item can be in one folder at a time.',
    okLabel: 'Create',
    placeholder: 'Keepers',
    required: 'Give the folder a name.',
  });
  if (!name) return false;
  try {
    await jpost(`/folders/${encodeURIComponent(scope)}`, { name });
  } catch (e) {
    await modal('Could not create the folder', esc(/** @type {ErrLike} */ (e).message || 'unknown error'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return false;
  }
  await loadFolders(scope);
  return true;
}

/** @param {string} scope @param {string} fid @returns {Promise<boolean>} */
export async function folderRename(scope, fid) {
  const name = await promptForName({
    title: 'Rename folder',
    blurb: 'Nothing moves — the items in it stay exactly where they are.',
    okLabel: 'Rename',
    initial: folderName(scope, fid),
    required: 'Give the folder a name.',
  });
  if (!name) return false;
  try {
    await jpost(`/folders/${encodeURIComponent(scope)}/${encodeURIComponent(fid)}`, { name });
  } catch (e) {
    await modal('Could not rename the folder', esc(/** @type {ErrLike} */ (e).message || 'unknown error'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return false;
  }
  await loadFolders(scope);
  return true;
}

/**
 * @param {string} scope @param {string} fid @param {number} n — how many rows are in it
 * @returns {Promise<boolean>}
 */
export async function folderDelete(scope, fid, n) {
  // 🔴 THE WORDING IS THE FEATURE. "Delete folder 'Keepers' (12 items)?" reads as delete-all to
  // anyone who has used any other program — and being unable to delete an item is no comfort to
  // someone who believes you just did. Say what happens to them, in the sentence, every time.
  const ok = await confirmDelete(
    'Remove this folder?',
    `<b>${esc(folderName(scope, fid))}</b> will be removed from the list.<br><br>` +
      (n
        ? `The <b>${n} item${n === 1 ? '' : 's'}</b> in it are <b>kept</b> — they go back to the ` +
          `main list, unfiled. Nothing is deleted.`
        : 'It is empty.'),
  );
  if (!ok) return false;
  try {
    // 🔴 `jdel`, NOT A BARE `fetch` — a bare one RESOLVES on 4xx/5xx, so this reported every
    // failed delete as a success. The route's two error arms are the ones worth hearing: a 400
    // for an unknown scope, and a 500 whose message is *"the folders file will not parse, so
    // nothing was written"* — precisely the case where the user must not believe the folder is
    // gone. Instead the confirm closed, `loadFolders` re-fetched, the folder was simply still
    // there, and nothing at all was said. Worse on a 401: every other verb in the app redirects
    // to /login (`jget`/`jpost`/`jdel` all do), while this one silently no-opped on a page that
    // could no longer write. Every sibling verb in this file already used `jpost` and reported.
    await jdel(`/folders/${encodeURIComponent(scope)}/${encodeURIComponent(fid)}`);
  } catch (e) {
    await modal('Could not remove the folder', esc(/** @type {ErrLike} */ (e).message || 'unknown error'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return false;
  }
  if (folderOpen(scope) === fid) setFolderOpen(scope, '');
  await loadFolders(scope);
  return true;
}

/**
 * File rows into a folder, or unfile them with `fid = ''`.
 * @param {string} scope @param {string[]} refs @param {string} fid
 * @returns {Promise<number|null>} how many rows the SERVER actually moved, or `null` when the
 *   request failed (the modal has already said so). `0` is a real answer and not an error: every
 *   ref was already where it was being sent, or — the case that matters — was not filed at all.
 */
export async function folderAssign(scope, refs, fid) {
  if (!refs || !refs.length) return 0;
  try {
    const r = /** @type {{moved?: number}} */ (await jpost(`/folders/${encodeURIComponent(scope)}/assign`, { refs, folder: fid || null }));
    // 🔴 THE COUNT, NOT `true` (9.7.0). The route has always answered `{moved}` and this threw it
    // away, so a request that succeeded and moved NOTHING was indistinguishable from one that
    // moved everything — the panel repainted identically and the user was told nothing. A control
    // that reports success over a no-op gives the caller no message to relay and no
    // difference to see. `null` is reserved for "the request failed", which is already explained
    // by the modal above it, so a caller can tell all three outcomes apart.
    return typeof r.moved === 'number' ? r.moved : refs.length;
  } catch (e) {
    await modal('Could not move them', esc(/** @type {ErrLike} */ (e).message || 'unknown error'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return null;
  }
}

// ── drag and drop (m2) ───────────────────────────────────────────────────────────────────
//
// Drag and click both assign the same selection to the same destination, so both use
// `folderAssign`.
//
// 🔴 THE REFS TRAVEL IN A MODULE VARIABLE, NOT IN `dataTransfer`. A `dragover` handler is
// forbidden from READING dataTransfer (only the drop event may), and `dragover` is where the
// drop target has to decide whether to accept — so a payload that only exists in dataTransfer
// cannot inform the decision. `setData` is still called, because a drag with no data is not a
// valid drag in Firefox.
/** @type {string[]} */
let DRAG_REFS = [];
let DRAG_SCOPE = '';

/**
 * 🔴 IS A DRAG IN FLIGHT? A POLL-DRIVEN LIST MUST ASK BEFORE IT REPAINTS.
 *
 * Several of these lists rebuild on a 1–2 s timer, and a repaint mid-drag destroys the element
 * under the cursor: the drag dies with no error, no drop event and nothing on screen to explain
 * it — it just "doesn't work sometimes", which reads as a flaky browser rather than as a bug.
 * The Voices tab does not poll, so this costs it nothing; the ACE library and the stems lists do,
 * and they must consult this before their timer repaints. Cheaper and far more obvious than
 * teaching every renderer to preserve a dragging node.
 * @returns {boolean}
 */
export const folderDragging = () => DRAG_REFS.length > 0;

/**
 * Which refs a drag actually carries.
 *
 * 🔴 DRAGGING A TICKED ROW TAKES THE WHOLE TICK SET; DRAGGING AN UNTICKED ONE TAKES ONLY IT.
 * The alternative — always sending the selection — silently moves rows you ticked ten minutes
 * ago and forgot about, from a gesture that pointed at exactly one row. The alternative in the
 * other direction (always just the grabbed row) makes the tick set useless for dragging, which
 * is the more natural of the two gestures for a set.
 *
 * 📌 A FUNCTION RATHER THAN THREE LINES INSIDE `dragstart`, because this is the whole decision
 * and a handler is not reachable from a test. `tests/voices_ui_smoke.mjs` pins it directly.
 *
 * @param {string} ref — the row the pointer actually grabbed
 * @param {string[]} [selected] - the panel's current tick set
 * @returns {string[]}
 */
export const dragRefs = (ref, selected) => ((selected || []).includes(ref) ? (selected || []).slice() : [ref]);

/**
 * Wire drag-to-file on one panel. Rows must carry `data-vrow="<ref>"` and `draggable="true"`.
 *
 * @param {string} hostId
 * @param {string|(() => string)} scope - a function when one host shows two lists; see `scopeOf`.
 * @param {{reload: (act: string) => any, selected?: () => string[]}} o
 */
export function folderWireDrag(hostId, scope, o) {
  const host = document.getElementById(hostId);
  if (!host || host.dataset.vfdrag) return;
  host.dataset.vfdrag = '1';

  const clear = () => {
    DRAG_REFS = [];
    DRAG_SCOPE = '';
    host.querySelectorAll('.vfdrop').forEach(n => n.classList.remove('vfdrop'));
    host.querySelectorAll('.vfdragging').forEach(n => n.classList.remove('vfdragging'));
  };

  host.addEventListener('dragstart', ev => {
    const row = /** @type {HTMLElement} */ (ev.target).closest('[data-vrow]');
    if (!row || !host.contains(row)) return;
    const ref = row.getAttribute('data-vrow') || '';
    DRAG_REFS = dragRefs(ref, o.selected ? o.selected() : []);
    DRAG_SCOPE = scopeOf(scope);
    // Mark every row that is actually traveling. The browser's drag image shows only the one
    // you grabbed, so a six-row move and a one-row move are otherwise indistinguishable until
    // they land — and the six-row one is the one you would want to abort.
    for (const r of DRAG_REFS) {
      const el = host.querySelector(`[data-vrow="${CSS.escape(r)}"]`);
      if (el) el.classList.add('vfdragging');
    }
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', DRAG_REFS.join('\n')); // Firefox needs SOME data
    }
  });
  host.addEventListener('dragend', clear);

  const targetFor = (/** @type {EventTarget|null} */ t) => {
    const el = t instanceof Element ? t.closest('[data-folder]') : null;
    return el && host.contains(el) ? /** @type {HTMLElement} */ (el) : null;
  };

  host.addEventListener('dragover', ev => {
    if (DRAG_SCOPE !== scopeOf(scope)) return; // a drag from another list is not ours to accept
    const t = targetFor(ev.target);
    if (!t) return;
    ev.preventDefault(); // "yes, you may drop here" — the ONLY way to say it
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    if (!t.classList.contains('vfdrop')) {
      host.querySelectorAll('.vfdrop').forEach(n => n.classList.remove('vfdrop'));
      t.classList.add('vfdrop');
    }
  });
  host.addEventListener('dragleave', ev => {
    const t = targetFor(ev.target);
    // Only when the pointer has actually left the row — `dragleave` also fires crossing between
    // a row's own children, and un-highlighting on those makes the target flicker under the hand.
    if (t && !t.contains(/** @type {Node|null} */ (ev.relatedTarget))) t.classList.remove('vfdrop');
  });

  host.addEventListener('drop', async ev => {
    const t = targetFor(ev.target);
    const sc = scopeOf(scope);
    if (!t || DRAG_SCOPE !== sc || !DRAG_REFS.length) return;
    ev.preventDefault();
    const refs = DRAG_REFS.slice();
    // `data-folder=""` is the divider under the folder block — dropping there UNFILES, which is
    // the gesture's other half. Since 8.9.12 that divider is rendered whenever the scope has any
    // folder at all, so it is a target even when nothing is unfiled yet; `⇤ Remove from folder`
    // on the toolbar is the same verb for people who would rather tick than drag.
    const fid = t.getAttribute('data-folder') || '';
    clear();
    if ((await folderAssign(sc, refs, fid)) !== null) await o.reload('move');
  });
}

/**
 * Put a `✚ Folder` button into a panel's controls row, immediately before `beforeId`.
 *
 * 🔴 BUILT HERE RATHER THAN WRITTEN INTO index.html, AND THE REASON IS A TEST. That page has a
 * hard line ceiling (`test_index_html_has_not_grown_past_its_ceiling`), whose message says
 * plainly: *"DO NOT RAISE THE CEILING. Move the new code into a module."* It grew from 314 lines
 * to 14,089 in ninety days without one commit looking large. Three hand-written buttons put it
 * over; ten would have been ten separate small justifications for raising a number that exists
 * precisely to refuse them. One function, called by each panel's own module, costs the page
 * nothing and makes the remaining scopes free.
 *
 * 📌 Idempotent — panels re-run their wiring on a tab switch.
 *
 * 🔴 AND IT PUTS `⇤ Remove from folder` NEXT TO IT (8.9.12), given a panel that can say what is
 * ticked. Filing had two gestures and un-filing had none you could find: `⇥ Move selected here`
 * sits on a folder ROW, and the only drag path back to the root is a divider that is not rendered
 * unless a row is already unfiled. The toolbar adds a discoverable remove-from-folder action.
 *
 * ⚠️ IT IS THE SAME TICK SET `⇥ Move selected here` READS, so the two are one gesture with two
 * destinations, and a panel that cannot answer `selected()` gets no button rather than a button
 * that would always say "nothing selected".
 *
 * @param {string|(() => string)} scope - a function when one toolbar serves two lists.
 * @param {string} beforeId — the control it is inserted in front of (each panel's ↻ Refresh)
 * @param {(act: string) => any} reload — called after a folder is created ('create') or rows are
 *   taken OUT of one ('move').
 *   🔴 IT TAKES THE ACTION FOR THE SAME REASON `folderWire` DOES, and getting it wrong is
 *   invisible: un-filing changes the SERVER's assignment, but every row's `.folder` stamp came
 *   down WITH the row, so a panel that merely re-renders paints the rows straight back into the
 *   folder they were just taken out of. The store is right and the screen is wrong, and it
 *   corrects itself on the next unrelated refresh — which is what makes it a bug report about
 *   something else, later. Measured in `vs_folders_browser_spec.mjs`, where the folder still read
 *   (2) after an un-file the server had already applied. A panel must REFETCH on 'move'.
 * @param {{selected?: () => string[]}} [o] - `selected` is the panel's tick set; with it, the
 *   ⇤ Remove from folder button is inserted too.
 */
export function folderAddButton(scope, beforeId, reload, o) {
  const anchor = document.getElementById(beforeId);
  if (!anchor || !anchor.parentElement) return;
  // The idempotency key is the scope when there is one; a resolver has no single scope, so the
  // anchor stands in for it — each panel's toolbar has its own, which is all the key needs to be.
  const key = typeof scope === 'function' ? `at:${beforeId}` : scope;
  if (anchor.parentElement.querySelector(`[data-vfadd="${key}"]`)) return;
  const b = document.createElement('button');
  b.className = 'sm';
  b.dataset.vfadd = key;
  b.textContent = '✚ Folder';
  b.title = 'Make a folder in this list. Folders are labels — nothing moves on disk, and an item can be in one folder at a time.';
  b.onclick = async () => {
    if (await folderCreate(scopeOf(scope))) await reload('create');
  };
  anchor.parentElement.insertBefore(b, anchor);
  const sel = o && o.selected;
  if (!sel) return;
  const u = document.createElement('button');
  u.className = 'sm';
  u.dataset.vfout = key;
  u.textContent = '⇤ Remove from folder';
  u.title =
    'Take the ticked rows OUT of their folder and back to the main list. Nothing is deleted and ' +
    'nothing moves on disk — a folder is a label, and this removes the label.';
  u.onclick = async () => {
    const refs = sel();
    if (!refs.length) {
      await modal('Nothing selected', 'Tick the rows you want to take out of their folder first.', [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
      return;
    }
    // 🔴 AND IT SAYS SO WHEN THE SERVER MOVED NOTHING (9.7.0). This used to repaint and stop,
    // which is the same picture as a broken button: the rows sit exactly where they were, with no
    // message anywhere on the page. It is reachable in ordinary use — tick a row at the root, or
    // one whose folder was deleted in another tab, and every ref pops nothing — and until now the
    // only way to tell that from a failure was to open the network pane.
    const moved = await folderAssign(scopeOf(scope), refs, '');
    if (moved === null) return; // the modal in folderAssign has already said why
    if (!moved) {
      await modal(
        'They were not in a folder',
        `Nothing changed: ${refs.length === 1 ? 'the ticked row was' : `all ${refs.length} ticked rows were`} already at the ` +
          `root of this list. This button only takes rows OUT of a folder — to put them in one, ` +
          `press <b>⇥ Move selected here</b> on the folder you want.`,
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
      return;
    }
    await reload('move');
  };
  anchor.parentElement.insertBefore(u, anchor);
}

/** Delegate folder-header actions so event handlers remain valid after repaint.
 * * @param {string} hostId — the id of the element the panel renders its rows into
 * @param {string|(() => string)} scope - a function when one host shows two lists; see `scopeOf`.
 * @param {{reload: (act: string) => any, selected?: () => string[], counts?: () => Record<string, number>}} o
 *  *
 * 🔴 `reload` IS TOLD WHICH ACTION FIRED, and the panel decides what that costs. Opening a
 * folder changes nothing on the server — it is pure UI state — so a panel can repaint from the
 * rows it already holds, while `move`/`rename`/`del` must re-FETCH because the server's stamps
 * are now stale. One callback that always refetched would put an HTTP round trip on every
 * folder click; one that never did would leave a moved row sitting in its old folder until
 * something else happened to reload. `act` is also where a panel clears its tick set, which is
 * why this is a parameter and not two callbacks.
 */
export function folderWire(hostId, scope, o) {
  const host = document.getElementById(hostId);
  if (!host || host.dataset.vfwired) return; // idempotent: panels re-wire on every tab switch
  host.dataset.vfwired = '1';
  host.addEventListener('click', async ev => {
    const btn = /** @type {HTMLElement} */ (ev.target).closest('[data-fact]');
    if (!btn || !host.contains(btn)) return;
    ev.preventDefault();
    const act = btn.getAttribute('data-fact');
    const fid = btn.getAttribute('data-fid') || '';
    const sc = scopeOf(scope); // resolved HERE: one host can be showing either of two lists
    if (act === 'open') {
      setFolderOpen(sc, fid);
      await o.reload(act);
    } else if (act === 'rename') {
      if (await folderRename(sc, fid)) await o.reload(act);
    } else if (act === 'del') {
      const n = (o.counts ? o.counts() : {})[fid] || 0;
      if (await folderDelete(sc, fid, n)) await o.reload(act);
    } else if (act === 'move') {
      const refs = o.selected ? o.selected() : [];
      if (!refs.length) {
        await modal('Nothing selected', 'Tick the rows you want to move first.', [{ label: 'OK', class: 'primary', value: 1 }]);
        return;
      }
      // ⚠️ `!== null`, NOT truthiness: `folderAssign` answers a COUNT now, and a move of zero rows
      // still has to repaint. Ticking six rows that are already in this folder spends the
      // selection exactly as it did before, which is what "the selection is spent" means.
      if ((await folderAssign(sc, refs, fid)) !== null) await o.reload(act);
    }
  });
}
