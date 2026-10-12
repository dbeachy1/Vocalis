/** Register event listeners for the World Book editor panes. This module exports no functions; importing it performs the single wiring pass. The deferred module runs after the document is parsed. Resolve `UIS` and `wbModeFilter` from the page's global lexical environment.
 */
import { wbAskName, wbConfirm } from '../ui/modal.js';
import { wbEl } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { jdel, jpost } from '../util/http.js';
import { wbApply, wbAssemble } from './apply.js';
import {
  wbFilterPaint,
  wbFindClose,
  wbFindGo,
  wbFindOpen,
  wbFindReplaceAll,
  wbFindReplaceOne,
  wbFindScan,
  wbFindState,
  wbFoldPaint,
  wbFoldUnticked,
  wbInvertTicks,
  wbModeFilter,
  wbPreflight,
  wbShutAll,
  wbTickable,
} from './edit.js';
import { wbSyncCardZoomTitle } from './face.js';
import { wbLogFold } from './log.js';
import {
  wbAddEntry,
  wbFixDepths,
  wbCloseEditor,
  wbDiscard,
  wbGo,
  wbImport,
  wbImportEntry,
  wbLoadLib,
  wbNewBook,
  wbNewCard,
  wbNewPersona,
  wbOpen,
  wbPicApply,
  wbPicCancel,
  wbPicState,
  wbPicSync,
  wbPicToggle,
  wbRun,
  wbSaveEdits,
  wbSetBookFilter,
  wbSortKey,
  WORLD_REF,
} from './open.js';
import { wbDownload } from './dl.js';
import { wbMergeImport } from './merge.js';
import { wbLoadInstructions, wbMarkVerdict, wbRepaintDiff, wbReview } from './pass.js';
import { wbSay } from './say.js';
import { wbStSend, wbStSweep } from './st.js';
import { wbGen, wbStale, wbState } from './state.js';

/** @param {string} kind */
function wbWire(kind) {
// 9.5.12 — All three panes expose document import. Vocalis personas are documents, so they use
// the same import path as cards and books.
  //
  // ⚠️ The `if` is not dead code waiting to be deleted: Assemble and the Library strip are still
  // pane-specific, and this file is ONE wiring function run for three panes. A control that is
  // absent must not throw here — that is the invariant, not which panes happen to have it today.
  if (wbEl(kind, 'wbImportBtn')) {
    /** @type {VEl} */ (wbEl(kind, 'wbImportBtn')).addEventListener('click', () => /** @type {VEl} */ (wbEl(kind, 'wbFile')).click());
    /** @type {VEl} */ (wbEl(kind, 'wbFile')).addEventListener('change', e => {
      if (/** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files)[0])
        wbGo(kind, wbImport(kind, /** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files)[0]));
      /** @type {HTMLInputElement} */ (e.target).value = '';
    });
  }
  // Assemble exists on World Books only — a card has no sections. Guarded rather than
  // duplicated: the two panes are the same markup, and a missing control must not throw.
  if (wbEl(kind, 'wbAssembleBtn')) {
// Ask for the name before file selection so canceling the dialog cannot discard a selected set
// of chunk files.
    let pendingName = '';
    /** @type {VEl} */ (wbEl(kind, 'wbAssembleBtn')).addEventListener('click', async () => {
      const name = await wbAskName(
        'Assemble a World Book',
        'Name the book this will build. Then pick every section chunk — plus build-config.json ' +
          'if you have one. Filename order (A_, B_, … X_) decides uid assignment.',
        '',
      );
      if (!name) return;
      pendingName = name;
      /** @type {VEl} */ (wbEl(kind, 'wbSecFiles')).click();
    });
    /** @type {VEl} */ (wbEl(kind, 'wbSecFiles')).addEventListener('change', e => {
      if (/** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files).length)
        wbGo(kind, wbAssemble(kind, [.../** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files)], pendingName));
      /** @type {HTMLInputElement} */ (e.target).value = '';
      pendingName = '';
    });
  }
// One press imports both books and cards, regardless of which sub-tab is open.
  /** @type {VEl} */ (wbEl(kind, 'wbStSweep')).addEventListener('click', () => wbGo(kind, wbStSweep(kind)));
// The browser spec checks the rendered width because stylesheet declarations alone cannot prove
// that this handler applies the full-card class.
  const cardImg = /** @type {VEl} */ (wbEl(kind, 'wbCard'));
  if (cardImg)
    cardImg.addEventListener('click', () => {
      // 🔴 9.5.13 — NOT WHILE HE IS PICKING THE FACE. `preventDefault()` on `pointerdown` does not
      // suppress the `click` that follows, so every release of a face drag ALSO landed here and
      // zoomed the picture to its own full size — which `wbPicToggle` shrinks out of on the way in
      // precisely because a square cannot be dragged on something taller than the viewport. It was
      // survivable while the picker was one-shot and one click; now that adjusting is the whole
      // point, it would fire on every tweak.
      if (wbPicState(kind).on) return;
      cardImg.classList.toggle('wbfull');
      wbSyncCardZoomTitle(cardImg);
    });
  // The sort control. Restored before the first load so the pane opens in his order, not in the
  // server's — the select's own default would otherwise win over a remembered choice.
  const sortSel = /** @type {HTMLSelectElement} */ (wbEl(kind, 'wbSort'));
  if (sortSel) {
    try {
      const saved = UIS.getItem(wbSortKey(kind));
      if (saved && [...sortSel.options].some(o => o.value === saved)) sortSel.value = saved;
    } catch (e) {}
    sortSel.addEventListener('change', () => {
      try {
        UIS.setItem(wbSortKey(kind), sortSel.value);
      } catch (e) {}
      wbGo(kind, wbLoadLib(kind));
    });
  }
  /** @type {VEl} */ (wbEl(kind, 'wbLib')).addEventListener('click', async e => {
    const del = /** @type {HTMLElement|null} */ (/** @type {Element} */ (e.target).closest('.wbdel'));
// Exclude row actions such as download and delete from the row's open/close target.
    const dl = /** @type {HTMLElement|null} */ (/** @type {Element} */ (e.target).closest('.wbdl'));
// Make the whole row the open/close target, including its whitespace.
    //
// Use `.wbrow`, not `.wbopen`; the editor is safe because `wbPlaceEditor` parks the pane
    // in a `.wbslot` that is a SIBLING of the row, so a click inside the open editor finds no
    // `.wbrow` ancestor. If that placement ever changes to nest inside the row, this handler
    // starts closing the editor on every keystroke in it.
    const row = !del && !dl && /** @type {HTMLElement|null} */ (/** @type {Element} */ (e.target).closest('.wbrow'));
    if (dl && dl.dataset.id) {
      // The latest revision, because the row is not showing one — and `pending` is read off the
      // row's own live badge rather than a `data-` attribute written at render time, because
      // `wbSyncRowPending` keeps that badge in step with saves and reverts and would leave a
      // rendered copy stale.
      wbGo(
        kind,
        wbDownload(kind, dl.dataset.id, {
          name: dl.dataset.name,
          pending: !!(dl.closest('.wbrow') && /** @type {Element} */ (dl.closest('.wbrow')).querySelector('.wbpend')),
        }),
      );
    }
    if (row && row.dataset.id) {
      // A second click on the row that is already open CLOSES it. Same control both ways — one
      // press opens, the same press again puts it away, and the button's label says which.
      if (row.dataset.id === wbState(kind).openId) wbCloseEditor(kind);
      else wbGo(kind, wbOpen(kind, row.dataset.id));
    }
    if (
      del &&
      (await wbConfirm(
        'Remove from Vocalis?',
        '<p>Remove this from Vocalis only — <b>SillyTavern is not affected</b>.</p>' +
          '<p class="small muted">Every revision kept here goes with it, and that cannot be ' +
          'undone.</p>',
        'Remove',
        true,
      ))
    ) {
      // 🔴 THE DELETE ITSELF WAS UNGUARDED: `jdel` throws on any non-2xx and this handler dropped
      // the rejection, so a 423 (vault locked) or a 500 removed the row from the pane, said
      // nothing, and left the document sitting on disk. The pane then disagreed with the store
      // until a reload.
      try {
        await jdel('/wbedit/documents/' + encodeURIComponent(/** @type {string} */ (del.dataset.id)));
      } catch (e) {
        const ex = /** @type {ErrLike} */ (e);
        wbSay(
          kind,
          ex.status === 423
            ? 'The vault is locked — nothing was removed.'
            : (ex.body && /** @type {string} */ (ex.body.error)) || ex.message || 'could not remove it',
          'bad',
        );
        return;
      }
      // 🔴 NOT IN THE REVIEW. This used to null `openId` and hide the pane while leaving `st.doc`,
      // `st.rev` and `st.fields` pointing at the DELETED document — and Export, ⬆ Save to
      // SillyTavern and Save all read `st.doc` and guard only on it being falsy. `wbCloseEditor`
      // is the one close path and now clears all of it, so deleting the open document goes
      // through it rather than reimplementing two thirds of it here.
      if (wbState(kind).openId === del.dataset.id) wbCloseEditor(kind);
      /** @type {VEl} */ (wbEl(kind, 'wbReview')).style.display = 'none';
      wbGo(kind, wbLoadLib(kind));
    }
  });
  // §8.2 — the worldbook filter. Cards pane only, so this is the one control in `wbWire` that is
  // not emitted for both sub-tabs; `wbLoadBookFilter` fills it and keeps it in step with the
  // books that actually exist.
  const wbBookSel = kind === 'cards' ? document.getElementById('wbBook_cards') : null;
  if (wbBookSel)
    wbBookSel.addEventListener('change', e => {
      wbSetBookFilter(/** @type {HTMLSelectElement} */ (e.target).value);
      wbGo(kind, wbLoadLib(kind));
    });
// §8.2 / 9.7.3 — The open card's world-book association is separate from the library filter and
// lives in the editor header. Cards only: a world book cannot be associated with another book.
  const wbWorldSel = kind === 'cards' ? document.getElementById('wbWorldPick_cards') : null;
  if (wbWorldSel)
    wbWorldSel.addEventListener('change', e => {
      const want = /** @type {HTMLSelectElement} */ (e.target).value;
      const st = wbState(kind);
      if (!st.doc) return;
      // 🔴 `WORLD_REF` NAMES A STATE, NOT A BOOK — the card points at something Vocalis does not
      // hold, so there is no id to post and the route requires one (§8.2 links by identity). It
      // is already the selected option in that state, so reaching here means he re-picked what
      // was showing; doing nothing is the honest answer, and posting the label as if it were an
      // id would file a `world_id` pointing at a document that does not exist.
      if (want === WORLD_REF) return;
      // 🔴 PINNED BEFORE THE REQUEST, exactly as ✎ Rename is. The roster behind the editor stays
      // clickable while this is in flight, and `st.doc.id` read afterward would set the world
      // book of whichever card he had moved to — the 5.1 shape, on a control that writes.
      const seq = wbGen(kind),
        docId = st.doc.id,
        revN = st.rev ? st.rev.n : undefined;
      wbGo(
        kind,
        (async () => {
          try {
            await jpost('/wbedit/documents/' + encodeURIComponent(docId) + '/world', { book: want });
          } catch (err) {
            const ex = /** @type {ErrLike} */ (err);
            wbSay(kind, (typeof ex.body?.error === 'string' && ex.body.error) || ex.message || 'could not change the world book', true);
            // 🔴 REDRAW FROM THE SERVER EVEN ON FAILURE. The `<select>` has ALREADY moved — the
            // browser changes it before the event fires — so a failed write leaves the control
            // asserting a link the store does not have, which is the one thing this pane must
            // never do. Reopening puts the real answer back under his cursor.
            if (!wbStale(kind, seq)) await wbOpen(kind, docId, revN);
            return;
          }
          if (wbStale(kind, seq)) return;
          // ⚠️ NAMES THE NEXT STEP, because this write does NOT reach SillyTavern on its own —
          // same sentence the picture upload and the face clear use, for the same reason.
          wbSay(kind, (want ? 'world book changed' : 'world book removed') + ' — press ⬆ Save to SillyTavern to send it', 'ok');
          await wbOpen(kind, docId, revN);
          // The roster carries the association too: it is what `?world=` filters on, so a card
          // that just left the filtered set has to leave the list with it.
          await wbLoadLib(kind);
        })(),
      );
    });
  // ⬇ Export (§6.3.2, m3). 🔴 THE REVISION IS THE OPEN ONE — exporting an older revision is how an
  // overwrite in SillyTavern gets undone (§8), and it is the only difference between this control
  // and the ⬇ on the roster row, which has no revision to name.
  //
  // 🔴 7.3.20 — THIS USED TO BE `window.location = url`, WITH A COMMENT ARGUING FOR IT: the
  // response is an attachment, so the browser saves it and never renders it. That reasoning only
  // covers the 200. `dl.js` has the rest of it — the short version is that a 423 has no
  // `Content-Disposition`, so the "download" navigates the editor away to a page of raw JSON.
// 11.1.8 — The books-pane export uses Save As so the JSON can be written to a chosen path.
  //
// Keep Export beside the import controls. The editor toolbar's flex spacer groups save actions
// separately, where Export was harder to find.
  //
// Place Export after Fix positions to preserve the measured toolbar wrapping and reading order.
  //
  // The Save-As itself is `dl.js`: the bytes are fetched BEFORE the dialog opens, because
  // confirming it truncates the file on disk and a 423 would otherwise leave a zero-byte backup
  // under the book's own name.
  //
// One handler serves the editor-header Export and the Library-strip Export file actions. Keeping
// revision selection in one implementation prevents the two entry points from diverging.
  /** @param {boolean} fromLibrary */
  const exportOpenDoc = fromLibrary => {
    const st = wbState(kind);
    if (!st.doc || !st.rev) {
      // 🔴 THE LIBRARY WORDING NAMES THE ROW BUTTON. This control is in the roster's own strip,
      // so "open a document first" reads as a dead end when the thing he wants is one click away
      // on the row itself. Teaching the ⬇ is what keeps this from being a third way to do the
      // same thing rather than a signpost to the other two.
      wbSay(
        kind,
        fromLibrary
          ? 'Open a document first — or press ⬇ on its row in the list to download the latest revision.'
          : 'Open a document first.',
        true,
      );
      return;
    }
    // The same computation `wbDiscard` uses for "are there unsaved edits": what was restored onto
    // THIS revision, falling back to the server's total, which is the only thing that can see a
    // draft stranded against an older one.
    wbGo(
      kind,
      wbDownload(kind, st.doc.id, {
        // 🔴 THE REVISION ON SCREEN, FROM BOTH DOORS. Re-exporting an older revision IS the undo
        // for an overwrite in SillyTavern (§8), so defaulting the Library one to "latest" would
        // quietly disarm that — and would make the two buttons disagree about what Export means.
        revision: st.rev.n,
        name: st.doc.name,
        pending: !!(Object.keys(st.draftAt || {}).length || st.draftTotal || 0),
      }),
    );
  };
  /** @type {VEl} */ (wbEl(kind, 'wbExport')).addEventListener('click', () => exportOpenDoc(false));
  // ⬇ Export file… is on Books and Cards; personas have the editor's own ⬇ Export instead (one
  // document, one revision), so this stays guarded like every other pane-specific control here.
  const exportFileBtn = /** @type {VEl} */ (wbEl(kind, 'wbExportFile'));
  if (exportFileBtn) exportFileBtn.addEventListener('click', () => exportOpenDoc(true));
  // ⬆ Save to SillyTavern (§7, m3) — the other half of Export, and the one that writes.
  /** @type {VEl} */ (wbEl(kind, 'wbSend')).addEventListener('click', () => wbGo(kind, wbStSend(kind)));

  // m4o — the picture. Books have none, so these three only exist on two of the three panes.
  const picUp = /** @type {VEl} */ (wbEl(kind, 'wbPicUpload'));
  if (picUp) {
    const file = /** @type {HTMLInputElement} */ (wbEl(kind, 'wbPicFile'));
    picUp.addEventListener('click', () => {
      file.value = '';
      file.click();
    });
    file.addEventListener('change', async () => {
      const st = wbState(kind),
        f = file.files && file.files[0];
      if (!f || !st.doc) return;
      // 🔴 THE BYTES, RAW. Not a canvas re-encode and not base64 in a JSON field: §4.3's rule is
      // that this image is never decoded, so an animated PNG stays animated and a ComfyUI
      // generation chunk survives. A canvas round trip would silently destroy both.
      wbSay(kind, 'uploading the picture…', 'busy');
      try {
        const r = await fetch('/wbedit/documents/' + encodeURIComponent(st.doc.id) + '/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: f,
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          wbSay(kind, j.error || 'the upload failed (HTTP ' + r.status + ')', true);
          return;
        }
        // 🔴 THE MANUAL CACHE-BUST THAT USED TO BE HERE IS GONE, AND ITS REMOVAL IS 9.5.12's THIRD
        // FIX. It set `img.src = …/avatar?t=' + Date.now()` BEFORE this reopen — and `wbOpen` ends
        // in `wbShowCard`, which sets the src itself, so the busted URL was overwritten by the
        // very next line. It read as a protection and was dead code; the comment above it
        // described a mechanism that never ran.
        //
        // What replaces it is `?v=<avatar_at>` inside `wbShowCard`: the picture's own (size,
        // mtime), so the URL changes exactly when the bytes do. That covers this upload AND the
        // path a `?t=` here never could — a face replaced by a `⟳ Import from SillyTavern` sweep
        // while this tab sits open, which Chrome otherwise paints from its per-page memory cache
        // without revalidating whatever the response header says. One mechanism, in one place,
        // and `wbedit_browser_spec.mjs` can fail on it.
        await wbOpen(kind, st.doc.id, st.rev ? st.rev.n : undefined);
        await wbLoadLib(kind);
        wbSay(kind, 'picture replaced — press Save to SillyTavern to send it', 'ok');
      } catch (e) {
        wbSay(kind, 'the upload failed', true);
      }
    });
    /** @type {VEl} */ (wbEl(kind, 'wbPicFocus')).addEventListener('click', () => wbPicToggle(kind));
// 9.5.13 — Save the selected face only when Apply is pressed, not on pointer movement.
    // ⚠️ `wbGo` on Apply, not on Cancel: one performs a request and must show the pane's busy
    // state, the other only touches local state and would flash a spinner over nothing.
    /** @type {VEl} */ (wbEl(kind, 'wbPicApply')).addEventListener('click', () => wbGo(kind, wbPicApply(kind)));
    /** @type {VEl} */ (wbEl(kind, 'wbPicCancel')).addEventListener('click', () => wbPicCancel(kind));
    /** @type {VEl} */ (wbEl(kind, 'wbPicFocusClear')).addEventListener('click', async () => {
      const st = wbState(kind);
      if (!st.doc) return;
      try {
        // `null`, not a zero rect — absent means "largest centered square" to BOTH products, and
        // `{x:0,y:0,w:0}` would mean a zero-width window their thumbnail endpoint would honor.
        const doc = await jpost('/wbedit/documents/' + encodeURIComponent(st.doc.id) + '/focus', {
          focus: null,
        });
        st.doc.focus = doc.focus;
        wbPicState(kind).rect = null;
        wbPicSync(kind);
        await wbLoadLib(kind);
        wbSay(kind, 'back to the centered square — press Save to SillyTavern to send it', 'ok');
      } catch (e) {
        wbSay(kind, 'could not clear the face', true);
      }
    });
  }
  /** @type {VEl} */ (wbEl(kind, 'wbClose')).addEventListener('click', () => wbCloseEditor(kind));
// §8.2's rename. The route does not rename documents from incoming pushes; rename is an explicit
// Vocalis-side action.
  // 🔴 Vocalis-side only. It renames the Library row, never the book in SillyTavern: their key is
  // `st_ref` and renaming that would break the link this app spent §8.2 establishing.
  /** @type {VEl} */ (wbEl(kind, 'wbRename')).addEventListener('click', async () => {
    const st = wbState(kind);
    if (!st.doc) return;
    // 🔴 PINNED BEFORE THE MODAL. `wbAskName` waits for a human, and the roster behind it is still
    // clickable — reading `st.doc.id` after it returned renamed whatever document the user had
    // moved to. Same shape as `wbApply`; see the generation-token block at the top of this pane.
    const seq = wbGen(kind),
      docId = st.doc.id,
      revN = st.rev ? st.rev.n : undefined;
    // Same native-dialog defect the assemble flow had, and the same fix — see `wbAskName`.
    const name = await wbAskName(
      'Rename this document',
      'This renames the Library row in Vocalis only. SillyTavern is not affected, and ' + 're-importing will not rename it back.',
      st.doc.name,
    );
    if (name === null) return; // Cancel, or blank, is not a rename
    if (wbStale(kind, seq)) {
      wbSay(kind, 'Rename canceled — you moved to another document.', true);
      return;
    }
    try {
      await jpost('/wbedit/documents/' + encodeURIComponent(docId) + '/rename', {
        name: name.trim(),
      });
      wbSay(kind, 'renamed', 'ok');
      if (wbStale(kind, seq)) return;
      await wbOpen(kind, docId, revN);
      await wbLoadLib(kind); // the roster carries the name too
    } catch (e) {
      const ex = /** @type {ErrLike} */ (e);
      wbSay(kind, (typeof ex.body?.error === 'string' && ex.body.error) || ex.message || 'could not rename it', true);
    }
  });
  /** @type {VEl} */ (wbEl(kind, 'wbRevPick')).addEventListener('change', e =>
    wbGo(kind, wbOpen(kind, wbState(kind).doc.id, +(/** @type {HTMLSelectElement} */ (e.target).value))),
  );
  /** @type {VEl} */ (wbEl(kind, 'wbRollback')).addEventListener('click', async () => {
    const st = wbState(kind);
    if (!st.doc || !st.rev) {
      wbSay(kind, 'Open a document first.', true);
      return;
    }
    // Pinned for the same reason, and the `jpost` was entirely unguarded: a 409 (someone else
    // moved the head) or a 423 threw into nothing and the button looked dead.
    const seq = wbGen(kind),
      docId = st.doc.id;
    let r;
    try {
      r = await jpost(`/wbedit/documents/${encodeURIComponent(docId)}/rollback/${st.rev.n}`);
    } catch (e) {
      const ex = /** @type {ErrLike} */ (e);
      wbSay(kind, (ex.body && /** @type {string} */ (ex.body.error)) || ex.message || 'could not roll back', 'bad');
      return;
    }
    wbSay(kind, 'rolled back — that is now revision ' + r.n + ', and the history is intact');
    if (wbStale(kind, seq)) return;
    await wbGo(kind, wbLoadLib(kind));
    await wbGo(kind, wbOpen(kind, docId));
  });
  // §9a.27 — BOTH triggers, ONE handler. Not a copy: a second implementation of the save path is
  // how the two drift, and the one that drifts is the one that stops minting a revision while
  // still saying it did. The pressed element is passed through so §9a.30 knows which to spin.
  // `currentTarget` is statically `EventTarget|null`; both listeners are bound directly to the
  // button, so it is really the `Element` `wbSaveEdits` (open.js) forwards to `wbSaveBusy`.
  /** @type {VEl} */ (wbEl(kind, 'wbSave')).addEventListener('click', ev =>
    wbGo(kind, wbSaveEdits(kind, /** @type {Element|null} */ (ev.currentTarget))),
  );
  /** @type {VEl} */ (wbEl(kind, 'wbSaveTop')).addEventListener('click', ev =>
    wbGo(kind, wbSaveEdits(kind, /** @type {Element|null} */ (ev.currentTarget))),
  );
  /** @type {VEl} */ (wbEl(kind, 'wbRevert')).addEventListener('click', () => wbGo(kind, wbDiscard(kind)));
  // 7.3.9f — the toolbar twin. ONE handler and one function: two controls that both mean "throw
  // the unsaved edits away" must not be two implementations of it, or the confirm text, the
  // stranded-draft fallback and the reopen drift apart between the top of the page and the bottom.
  /** @type {VEl} */ (wbEl(kind, 'wbRevertTop')).addEventListener('click', () => wbGo(kind, wbDiscard(kind)));
  // 🔴 m4y — ALL THREE SELECTION VERBS ACT ON WHAT IS VISIBLE. Over a filtered entry list, "tick
  // all" means "every entry I can see"; reaching hidden rows would build a pass out of entries he
  // is not looking at.
  // ⚠️ §9a.32 — `wbTickable`, NOT `wbVisibleTicks`: an empty card field is visible and cannot be
  // in a pass, and `checked = true` on a disabled box succeeds silently.
  /** @type {VEl} */ (wbEl(kind, 'wbAll')).addEventListener('click', () => {
    wbTickable(kind).forEach(c => (c.checked = true));
    wbFoldPaint(kind);
    wbPreflight(kind);
  });
  /** @type {VEl} */ (wbEl(kind, 'wbNone')).addEventListener('click', () => {
    wbTickable(kind).forEach(c => (c.checked = false));
    wbFoldPaint(kind);
    wbPreflight(kind);
  });
  /** @type {VEl} */ (wbEl(kind, 'wbInvert')).addEventListener('click', () => wbInvertTicks(kind));
  /** @type {VEl} */ (wbEl(kind, 'wbFold')).addEventListener('click', () => wbFoldUnticked(kind));
  // §9a.31 — wired for all three kinds because `wbWire` runs off one body; `wbEntryCtl` is what
  // decides whether they are ever visible, and it asks the document rather than the pane.
  /** @type {VEl} */ (wbEl(kind, 'wbExpandAll')).addEventListener('click', () => wbShutAll(kind, false));
  /** @type {VEl} */ (wbEl(kind, 'wbCollapseAll')).addEventListener('click', () => wbShutAll(kind, true));
  // Books only — a persona has no injection mode, and a card's own fields do not either. Guarded
  // rather than assumed: `wbWire` runs for all three kinds off one body.
  // m4z / §9a.19 — books only: a card's fields are fixed by the card format and a persona's by
  // SillyTavern's two maps, so "add an entry" has no meaning on either.
  const newBookBtn = /** @type {VEl} */ (wbEl(kind, 'wbNewBook'));
  if (newBookBtn) newBookBtn.addEventListener('click', () => wbGo(kind, wbNewBook(kind)));
  // §9a.11 — personas only, and guarded the same way for the same reason: one body wires all
  // three panes, so a control that is not on this one must not throw here.
  const newPersonaBtn = /** @type {VEl} */ (wbEl(kind, 'wbNewPersona'));
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => wbGo(kind, wbNewPersona(kind)));
  // §9a.11's second half — cards only, guarded identically.
  const newCardBtn = /** @type {VEl} */ (wbEl(kind, 'wbNewCard'));
  if (newCardBtn) newCardBtn.addEventListener('click', () => wbGo(kind, wbNewCard(kind)));
  const addEntryBtn = /** @type {VEl} */ (wbEl(kind, 'wbAddEntry'));
  if (addEntryBtn) addEntryBtn.addEventListener('click', () => wbGo(kind, wbAddEntry(kind)));
  // 7.3.20 — ⬆ Import entry, beside ✚ Add entry because it is the same act with the text already
  // written. World Books only, guarded the same way Assemble is: the panes share this markup and a
  // control that is not on this one must not throw here.
  // ⚠️ `e.target.value=''` AFTER the handoff, exactly as the document import above does it —
  // without it, picking the SAME file twice fires no `change` event at all and the second import
  // looks like a dead button.
  const entryBtn = /** @type {VEl} */ (wbEl(kind, 'wbImportEntry'));
  if (entryBtn) {
    entryBtn.addEventListener('click', () => /** @type {VEl} */ (wbEl(kind, 'wbEntryFile')).click());
    /** @type {VEl} */ (wbEl(kind, 'wbEntryFile')).addEventListener('change', e => {
      if (/** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files)[0])
        wbGo(kind, wbImportEntry(kind, /** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files)[0]));
      /** @type {HTMLInputElement} */ (e.target).value = '';
    });
  }
  // 9.6 — ⇄ Import & merge. On BOTH panes and guarded the same way every other optional control
  // here is: `wbWire` runs off one body for all three kinds, so a control that is not on this one
  // must not throw. Both panes keep it in the EDITOR toolbar — the books one beside ⬆ Import
  // entry, the cards one beside ⬇ Export. Personas have no button, because their merge door does
  // not exist — see `_MERGEABLE`.
  //
  // 🔴 9.6.6 — THE CARDS COPY SHIPPED IN THE LIBRARY STRIP, WHICH IS THE ONE PLACE IT CANNOT BE
  // USED FROM. That strip holds the controls that act on the LIBRARY — ⟳ Import from SillyTavern,
  // ⬆ Import file…, ✚ New Character Card… — and `wbMergeImport` refuses outright unless `st.doc`
  // is set. So the only route to it was: open a card, scroll back up to a strip that is otherwise
  // about everything EXCEPT the card on screen. Beside ⬇ Export, on the open card's own header, it
  // reads as what it is — the inbound half of the pair that exports THIS revision — and its "Open
  // a character card first" dead end is now unreachable rather than merely unlikely.
  //
  // ⚠️ Its own hidden <input>, and it TRAVELS WITH THE BUTTON: sharing `wbEntryFile` would give
  // one element two `change` listeners and every file picked would fire both doors, and leaving
  // the input behind in the strip would leave the picker wired to a node outside the pane. The
  // browser spec asserts the pair share a parent for that reason.
  const mergeBtn = /** @type {VEl} */ (wbEl(kind, 'wbMergeImport'));
  if (mergeBtn) {
    mergeBtn.addEventListener('click', () => /** @type {VEl} */ (wbEl(kind, 'wbMergeFile')).click());
    /** @type {VEl} */ (wbEl(kind, 'wbMergeFile')).addEventListener('change', e => {
      if (/** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files)[0])
        wbGo(kind, wbMergeImport(kind, /** @type {FileList} */ (/** @type {HTMLInputElement} */ (e.target).files)[0]));
      // Cleared AFTER the handoff, exactly as ⬆ Import entry does: without it, picking the SAME
      // file twice fires no `change` at all and the second press looks like a dead button.
      /** @type {HTMLInputElement} */ (e.target).value = '';
    });
  }
  // 9.4 — ⇊ Fix positions, World Books only and guarded the same way ✦ Add entry is: one
  // body wires all three panes, so a control that is not on this one must not throw here.
  const fixDepthsBtn = /** @type {VEl} */ (wbEl(kind, 'wbFixDepths'));
  if (fixDepthsBtn) fixDepthsBtn.addEventListener('click', () => wbGo(kind, wbFixDepths(kind)));
  const modeSel = /** @type {VEl} */ (wbEl(kind, 'wbEntryMode'));
  if (modeSel)
    modeSel.addEventListener('change', e => {
      // `wbModeFilter` is `edit.js`'s export, untyped there — cast at this use site (8.3-m2 scope).
      /** @type {Record<string, string>} */ (wbModeFilter)[kind] = /** @type {HTMLSelectElement} */ (e.target).value;
      wbFilterPaint(kind);
      wbPreflight(kind);
      // 🔴 THE HIT LIST IS BUILT FROM WHAT WAS VISIBLE, so changing the filter invalidates it. Left
      // stale, an open find bar kept pointing at entries the filter had just hidden — the same dead
      // Ctrl+F3 by a slower route — and Replace All would still have edited them.
      wbFindScan(kind);
    });
  /** @type {VEl} */ (wbEl(kind, 'wbRun')).addEventListener('click', () => wbGo(kind, wbRun(kind, false)));
  /** @type {VEl} */ (wbEl(kind, 'wbPreview')).addEventListener('click', () => wbGo(kind, wbRun(kind, true)));
  /** @type {VEl} */ (wbEl(kind, 'wbCancel')).addEventListener('click', async () => {
    const st = wbState(kind);
    await jpost(`/wbedit/pass/${encodeURIComponent(st.doc.id)}/${encodeURIComponent(st.pass.id)}/cancel`).catch(() => {});
  });
  /** @type {VEl} */ (wbEl(kind, 'wbInsPick')).addEventListener('change', e => {
    // `_items` is declared on Element (it is one of this app's node expandos), and `e.target` is
    // an EventTarget. Narrowing here rather than widening EventTarget in dom-permissive.d.ts:
    // that file's member count is pinned precisely so "add one more" does not become the reflex.
    const items = /** @type {ReadonlyArray<{id: string, text: string}>} */ (/** @type {Element} */ (e.target)._items || []);
    const found = items.find(i => i.id === /** @type {HTMLSelectElement} */ (e.target).value);
    if (found) /** @type {HTMLTextAreaElement} */ (wbEl(kind, 'wbIns')).value = found.text;
  });
  /** @type {VEl} */ (wbEl(kind, 'wbInsSave')).addEventListener('click', async () => {
    const text = /** @type {HTMLTextAreaElement} */ (wbEl(kind, 'wbIns')).value.trim();
    if (!text) {
      wbSay(kind, 'nothing to save', true);
      return;
    }
    // The third native `prompt()`, replaced with the rest of them — see `wbAskName`.
    const name = await wbAskName(
      'Name this instruction',
      'The instruction library is shared by Character Cards, World Books and Personas. ' +
        'Pass quality is almost entirely determined by the instruction, so this is worth naming ' +
        'well.',
      text.slice(0, 60),
    );
    if (name === null) return;
    try {
      await jpost('/wbedit/instructions', { name, text, kind: '' });
    } catch (e) {
      const ex = /** @type {ErrLike} */ (e);
      wbSay(kind, (ex.body && /** @type {string} */ (ex.body.error)) || ex.message || 'could not save it', 'bad');
      return;
    }
    wbSay(kind, 'saved to the instruction library', 'ok');
    wbGo(kind, wbLoadInstructions(kind));
  });
  /** @type {VEl} */ (wbEl(kind, 'wbInsDel')).addEventListener('click', async () => {
    const id = /** @type {HTMLSelectElement} */ (wbEl(kind, 'wbInsPick')).value;
    if (!id) {
      wbSay(kind, 'pick a saved instruction first', true);
      return;
    }
    if (
      !(await wbConfirm(
        'Delete this saved instruction?',
        '<p class="small muted">The instruction text is removed from the library. Documents and ' + 'revisions are untouched.</p>',
        'Delete',
        true,
      ))
    )
      return;
    try {
      await jdel('/wbedit/instructions/' + encodeURIComponent(id));
    } catch (e) {
      const ex = /** @type {ErrLike} */ (e);
      wbSay(kind, (ex.body && /** @type {string} */ (ex.body.error)) || ex.message || 'could not delete it', 'bad');
      return;
    }
    wbGo(kind, wbLoadInstructions(kind));
  });
  // §6.6 find & replace
  // 🔴 7.3.9b — THE SAME ENTRY POINT Ctrl+F USES, NOT A SECOND ONE. `wbFindOpen` shows the bar,
  // focuses the query and selects what is in it, so pressing the button while the bar is already
  // open puts the cursor back where he wants to type — which is what the key does too. A separate
  // "toggle" handler here would be a second definition of open, and the two would drift.
  /** @type {VEl} */ (wbEl(kind, 'wbFindOpen')).addEventListener('click', () => wbFindOpen(kind));
  /** @type {VEl} */ (wbEl(kind, 'wbFindQ')).addEventListener('input', () => {
    wbFindState(kind).at = -1;
    wbFindScan(kind);
  });
  /** @type {VEl} */ (wbEl(kind, 'wbFindCase')).addEventListener('change', () => wbFindScan(kind));
  /** @type {VEl} */ (wbEl(kind, 'wbFindWord')).addEventListener('change', () => wbFindScan(kind));
  /** @type {VEl} */ (wbEl(kind, 'wbFindNext')).addEventListener('click', () => wbFindGo(kind, 1));
  /** @type {VEl} */ (wbEl(kind, 'wbFindPrev')).addEventListener('click', () => wbFindGo(kind, -1));
  /** @type {VEl} */ (wbEl(kind, 'wbFindOne')).addEventListener('click', () => wbFindReplaceOne(kind));
  /** @type {VEl} */ (wbEl(kind, 'wbFindAll')).addEventListener('click', () => wbGo(kind, wbFindReplaceAll(kind)));
  /** @type {VEl} */ (wbEl(kind, 'wbFindClose')).addEventListener('click', () => wbFindClose(kind));
  /** @type {VEl} */ (wbEl(kind, 'wbFindQ')).addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      wbFindGo(kind, e.shiftKey ? -1 : 1);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      wbFindClose(kind);
    }
  });
  /** @type {VEl} */ (wbEl(kind, 'wbFindR')).addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      wbFindReplaceOne(kind);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      wbFindClose(kind);
    }
  });
  // 🔴 THERE IS NO ↻ REFRESH BUTTON ANY MORE, AND REMOVING IT IS PART OF THE FIX (§9a.13).
  // Pressing Refresh re-ran the fetch the timer was already running, so it
  // could not have helped, and its presence advertised a window that does not keep itself
  // current. A window that polls itself every second has nothing to offer behind a button.
  // 🔴 **COLLAPSE, NEVER HIDE.** Hiding the panel removed the only route back to it.
  //
  // The old handler set the whole panel to `display:none`, and the ONLY things that ever set it
  // back are `wbOpen` and `wbLogStart` — so once hidden, the log was unreachable until the user
  // happened to reopen the document or start another pass, with nothing on screen to suggest
  // either. A control whose effect cannot be undone from the same control is a trap.
  //
  // Now the header row always stays and only the body folds away, so the toggle that closed it
  // is sitting in the same place. The poll keeps running while collapsed on purpose: the
  // count in the header is still live, which is the one thing worth seeing when it is folded.
  /** @type {VEl} */ (wbEl(kind, 'wbLogCollapse')).addEventListener('click', () => {
    const st = wbState(kind);
    st.logFolded = !st.logFolded;
    wbLogFold(kind);
  });
  // 🔴 THE VERDICT IS PAINTED ONLY IF THE SERVER TOOK IT. Both of these used to `await` the POST
  // with no catch and then mark every row regardless — so a 423 or a 409 left the pane showing
  // "approved" on a review the server never recorded, and Apply would then act on a different set
  // than the one on screen. Marking after a failure is the report-success-for-nothing shape.
  /** @param {string} verdict */
  const reviewAll = async verdict => {
    const st = wbState(kind);
    if (!st.doc || !st.pass) {
      wbSay(kind, 'Run a pass first.', true);
      return;
    }
    const seq = wbGen(kind);
    try {
      await jpost(`/wbedit/pass/${encodeURIComponent(st.doc.id)}/${encodeURIComponent(st.pass.id)}/review-all`, { review: verdict });
    } catch (e) {
      const ex = /** @type {ErrLike} */ (e);
      wbSay(kind, (ex.body && /** @type {string} */ (ex.body.error)) || ex.message || 'could not record that', 'bad');
      return;
    }
    if (wbStale(kind, seq)) return;
    /** @type {VEl} */ (wbEl(kind, 'wbProposals')).querySelectorAll('.wbprop').forEach(d => wbMarkVerdict(d, verdict));
  };
  /** @type {VEl} */ (wbEl(kind, 'wbApproveAll')).addEventListener('click', () => wbGo(kind, reviewAll('approved')));
  /** @type {VEl} */ (wbEl(kind, 'wbRejectAll')).addEventListener('click', () => wbGo(kind, reviewAll('rejected')));
  /** @type {VEl} */ (wbEl(kind, 'wbApply')).addEventListener('click', () => wbGo(kind, wbApply(kind)));
  /** @type {VEl} */ (wbEl(kind, 'wbProposals')).addEventListener('click', e => {
    const div = /** @type {HTMLElement|null} */ (/** @type {Element} */ (e.target).closest('.wbprop'));
    if (!div) return;
    const i = +(/** @type {string} */ (div.dataset.index));
    if (/** @type {Element} */ (e.target).closest('.wbok')) wbGo(kind, wbReview(kind, i, 'approved'));
    if (/** @type {Element} */ (e.target).closest('.wbno')) wbGo(kind, wbReview(kind, i, 'rejected'));
    if (/** @type {Element} */ (e.target).closest('.wbtoggle')) {
      const panes = /** @type {HTMLElement} */ (div.querySelector('.wbpanes'));
      const hidden = panes.style.display === 'none';
      panes.style.display = hidden ? '' : 'none';
      /** @type {HTMLElement} */ (e.target).textContent = hidden ? 'Hide' : 'Show';
    }
  });
  // §6.3 — the diff follows his typing. DELEGATED, because rows stream in one at a time (§6.3.1)
  // and there is no moment at which they are all present to be wired individually.
  /** @type {VEl} */ (wbEl(kind, 'wbProposals')).addEventListener('input', e => {
    if (!(/** @type {Element} */ (e.target).classList) || !(/** @type {Element} */ (e.target).classList.contains('wbedited'))) return;
    const div = /** @type {HTMLElement|null} */ (/** @type {Element} */ (e.target).closest('.wbprop'));
    if (div) wbRepaintDiff(div);
  });
  // 🔴 `scroll` DOES NOT BUBBLE, so this one is registered in the CAPTURE phase. The same handler
  // on the bubble phase never fires, and the symptom is not "no highlight" but a highlight that is
  // right until the first long field is scrolled and wrong for the rest of the session.
  /** @type {VEl} */ (wbEl(kind, 'wbProposals')).addEventListener(
    'scroll',
    e => {
      if (!(/** @type {Element} */ (e.target).classList) || !(/** @type {Element} */ (e.target).classList.contains('wbedited'))) return;
      const hl = /** @type {HTMLElement} */ (/** @type {HTMLTextAreaElement} */ (e.target).parentElement).querySelector('.wbhl');
      if (hl) hl.scrollTop = /** @type {Element} */ (e.target).scrollTop;
    },
    true,
  );
}

// 🔴 THE THREE PANES, WIRED ONCE, AT MODULE LOAD. These were the last three statements of the
// inline script and they are the last three statements of the split. Do not make them lazy or
// per-tab-switch: `wbWire` REGISTERS listeners, so running it twice for a kind gives every control
// two of them and the second press of Save would mint two revisions.
wbWire('cards');
wbWire('books');
wbWire('personas');
