// The editing surface: the field renderers, the typed settings controls, the dirty/draft
// model, the tick/fold state, and find & replace. 7.1 §5.5 — module 8, and the biggest.
//
// 🔴 THE SAVE CHAIN IS DELIBERATELY NOT HERE (§5.8). §5 filed `wbSaveEdits` under this module,
// and that one assignment made `edit.js` and `open.js` import each other: `wbSaveApply`'s last act
// is navigation — reload the roster, re-open the document, restore the scroll — so it belongs with
// `wbOpen`. Moving it there leaves this module with ZERO edges into `open.js`, measured, and the
// dependency runs one way: `open.js` imports this, never the reverse. The cycle was a filing error,
// not a structural one, and re-drawing the boundary beat building a second registry.
//
// ⚠️ `WB_MODES` and `WB_SET_SKIP` CAME WITH IT, and that was not automatic. This module is eight
// fragments in the old file, not one block, with const tables sitting between the runs — and a
// table left behind is `undefined` at CALL time, not an import error at load. Each table was
// assigned by asking who reads it: these two are read only from here; `WB_PANE`, `WB_HOME`,
// `WB_TICK_TIP` and `WB_LOG_POLL_MS` are read from the open side and stayed.
//
// ⚠️ `wbEstimate`, `wbMins` and `wbTitleInput` came too — small leaves whose only callers are in
// here. Leaving them behind would have been the same silent breakage as a stranded table.
//
// ⚠️ Nothing here runs at parse time; every entry point is a listener `wbWire` registers, or
// `wbOpen` rebuilding the pane. Hand-checked per §5.6.

import { esc, scrollUnderStick, stickTop, wbEl } from '../util/dom.js';
import { WB_KIND } from './kind.js'; // 7.3-m13
import { jput } from '../util/http.js';
import { wbState, wbGen, wbStale } from './state.js';
import { wbSay } from './say.js';
import { wbConfirm } from '../ui/modal.js';

// ── Local shapes, used only for casts within THIS file ──────────────────────────────────────
//
// 🔴 NOT A SHARED TYPE, DELIBERATELY. `wbState(kind)` itself stays `any` (see `state.js`'s
// header) because its fields are read and written by name from `open.js`/`wire.js`/`st.js` too,
// and pinning a shape there would decide it for all of `wb/` mid-fan-out. These typedefs exist
// only so THIS file can cast a `wbState(kind).fields`/`.rev` read to something the checker can
// verify — they are read off how `open.js` builds and reads them (measured, not guessed), but
// declaring them here rather than in `state.js` means nothing outside this file is affected by
// them, and a future shared-type pass is free to shape `WbPaneState` differently.

/**
 * One row of the typed field list `open.js` builds from `/wbedit/documents/<id>/fields` and
 * stores as `st.fields`. `locator`/`entry` are paths into `st.rev.content`, walked by
 * `wbGetAt`/`wbRawAt` — a compiled lorebook's `entries` is a dict keyed by the STRING "3", a
 * section chunk's is a list indexed by the INT 3, hence the mixed tuple.
 * @typedef {Object} WbField
 * @property {(string|number)[]} locator - path to this field's own text.
 * @property {(string|number)[]} [entry] - present when this field is a worldbook/card ENTRY;
 *   the path to the entry object, and the prefix `wbSetLoc` appends a setting name onto.
 * @property {string} label
 * @property {number} chars
 * @property {boolean} [empty] - the server's answer, never guessed from `chars` (§9a.32).
 * @property {string} [mode] - `WB_MODES`' key: `'constant'`/`'normal'`/`'vectorized'`/`'disabled'`.
 */

/**
 * One option of an `enum`/`enum?` setting control.
 * @typedef {Object} WbSettingOption
 * @property {unknown} value - JSON round-tripped through the `<option value>` (m5g) — may be
 *   `null`, a bool, a number or a string, never assumed to be one of them.
 * @property {string} label
 */

/**
 * One entry in the typed settings table `/fields` sends alongside the field list — what
 * `wbSetControl`/`wbSetRead` draw and parse a single ⚙-fold control from.
 * @typedef {Object} WbSettingSpec
 * @property {string} name - the key this control writes, under `f.entry`.
 * @property {string} label
 * @property {string} type - `'bool'|'bool?'|'enum'|'enum?'|'int'|'int?'|'array'|'boolint'|'string'`.
 * @property {string} [tip]
 * @property {string} [placeholder]
 * @property {number} [min]
 * @property {number} [max]
 * @property {WbSettingOption[]} [options]
 * @property {string} [group] - `WbSettingGroup.key` this control is drawn under.
 */

/**
 * One heading `wbSetBuild` groups controls under.
 * @typedef {Object} WbSettingGroup
 * @property {string} key
 * @property {string} label
 */

/**
 * One field-search hit — `wbFindScan`'s output, walked by `wbFindGo`/`wbFindReplaceOne`/
 * `wbFindReplaceAll`.
 * @typedef {Object} WbFindHit
 * @property {number} fi - the field's index among rendered `.wbfield` boxes (§ header order).
 * @property {Element} [box] - the field's row; present for every entry hit, absent for a
 *   card's own (non-entry) field.
 * @property {Element} [ta] - the body `<textarea>`; present for a body hit, absent for a title
 *   hit (title hits materialize their control lazily — see `wbFindEl`).
 * @property {boolean} [title] - true when this hit is in the entry's title (`comment`), not body.
 * @property {number} start
 * @property {number} end
 */

// The preflight is deliberately pessimistic: it estimates every field as if it will change, so a
// pass that finishes early is preferable to one that overruns its estimate.
/**
 * @param {number} chars
 * @param {number} fields
 * @returns {number} estimated seconds.
 */
export function wbEstimate(chars, fields) {
  return Math.round(fields * 6 + chars * 0.012);
}
/** @param {number} s seconds @returns {string} */
export function wbMins(s) {
  return s < 90 ? s + 's' : Math.round(s / 60) + ' min';
}
// ── pending edits that survive a restart (§9a.15) ────────────────────────────
//
// Blur persists pending edits across reloads and restarts, but does not apply them to the document.
// Only Save creates a revision; the editor overlays the pending draft when it reopens.
// marked dirty so the Save control is still showing and still the thing that commits.
//
// 📌 On blur rather than on input: a keystroke-rate PUT would be a request per character against
// a routed, encrypted, read-modify-write store. Leaving the box is the natural commit point and
// it is the moment he would expect it — the same instant the browser would autosave a form.
/**
 * @param {string} kind
 * @param {Element} ta - the field's `<textarea>`, reached by `.closest`/`querySelector` — see
 *   `dom-permissive.d.ts` for why `Element` rather than a concrete input type.
 */
export async function wbSaveDraft(kind, ta) {
  const st = wbState(kind);
  if (!st.doc || !st.rev || !st.fields) return;
  // 🔴 THIS FIRES FROM A `blur` ON EVERY TEXTAREA, so it is the single most likely thing in the
  // pane to be in flight across a document switch. Everything it needs is read and PINNED before
  // the await: `ta.dataset.i` indexes `st.fields`, which `wbOpen` replaces wholesale, so a blur
  // landing mid-open resolved an index against the NEXT document's field list and filed the text
  // under the wrong locator.
  const seq = wbGen(kind),
    docId = st.doc.id,
    revN = st.rev.n;
  /** @type {WbField[]} */
  const fields = st.fields;
  const f = fields[+(/** @type {string} */ (/** @type {HTMLTextAreaElement} */ (ta).dataset.i))];
  if (!f) return;
  const original = wbGetAt(st.rev.content, f.locator);
  // A field put back to its original text clears its draft rather than storing a no-op — else
  // reopening would "restore" text identical to the revision and mark it dirty for nothing.
  const text = /** @type {HTMLTextAreaElement} */ (ta).value === original ? null : /** @type {HTMLTextAreaElement} */ (ta).value;
  const key = JSON.stringify(f.locator);
  if (st.draftAt && st.draftAt[key] === text) return; // nothing new
  try {
    const res = await jput(`/wbedit/documents/${encodeURIComponent(docId)}/draft`, {
      revision: revN,
      locator: f.locator,
      text,
    });
    // 7.3.9g — the server's own count, straight onto the Library row. See `wbSyncRowPending`:
    // patched rather than re-fetched, because this runs on every blur.
    wbSyncRowPending(kind, docId, +res.pending || 0);
    // ⚠️ ONLY IF WE ARE STILL ON THAT DOCUMENT. The dedupe key used to be written here
    // unconditionally, after the await — so a late PUT resolving after `wbOpen` had swapped
    // documents seeded the NEXT document's map with this document's text, and the next blur on a
    // field that happened to share a locator was then skipped as "nothing new".
    if (wbStale(kind, seq)) return;
    st.draftAt[key] = text;
  } catch (e) {
    // 🔴 A FAILED DRAFT MUST NOT EAT HIS TYPING OR SHOUT AT HIM. The text is still in the box and
    // Save still works; this is a safety net failing, not the edit. Say it once, quietly.
    wbSay(kind, 'could not stash the pending edit — it is still in the box, and Save still works', true);
  }
}
// ── 7.3.9c: the ⚙ fold's fields were NOT covered, and that was silent loss ───────────────────
//
// Draft persistence must cover settings controls as well as the body. Without it, a refresh could
// discard edits to Keywords, Title, Order, Sticky, and other fields in the settings fold.
//
// 🔴 **THE VALUE IS JSON-ENCODED INTO THE SAME `text` STRING THE BODY DRAFTS USE, AND THAT CHOICE
// IS WHAT KEEPS THE SERVER OUT OF IT.** A setting is a bool, an int, a string, a list of strings —
// or `null`, which for `int?` and `bool?` is a REAL VALUE meaning "use the global". The wire
// already spends `text: null` on "clear this draft", so sending a raw null would delete the very
// edit it was meant to record. Encoding gives `"null"`, four characters, unambiguously distinct
// from the JSON null that clears — so the route, its validation and the on-disk shape are all
// untouched, and an older client simply ignores a key it cannot match.
//
// ⚠️ **ON `change` AND `blur`, NEVER ON `input`.** `wbSetDirty` runs on `input` because the outline
// has to track the caret; a PUT per keystroke into Keywords is the request-per-character storm the
// body path already refused. `change` covers selects and checkboxes immediately and text inputs on
// blur; the explicit `blur` is for the case where the value was typed and reverted, where `change`
// never fires but a stale draft may still be sitting on the server.
/**
 * @param {WbField} f
 * @param {string} name
 * @returns {string}
 */
export function wbDraftSetKey(f, name) {
  return JSON.stringify(wbSetLoc(f, name));
}
// Keep the roster's pending count synchronized when drafts are created or discarded.
//
// Patch the existing row instead of refetching the library. Every draft PUT already answers with the
// server's own `pending` count, so the number is in hand at exactly the moments it changes. A
// `wbLoadLib` per blur would be a full library round trip per keystroke-group — the request storm
// the draft path was written to avoid — and it would repaint the list during editing.
//
// ⚠️ Silent when the row is not on screen (a filter, another sub-tab, the editor open on its own).
// This is a decoration on a list that may not be rendered; it must never be a reason anything
// throws, and the next `wbLoadLib` builds it from `pending` in the listing anyway.
/**
 * @param {string} kind
 * @param {string} docId
 * @param {number} n - the server's own pending-edit count for this document.
 */
export function wbSyncRowPending(kind, docId, n) {
  const lib = /** @type {VEl} */ (wbEl(kind, 'wbLib'));
  const row = lib && lib.querySelector('.wbrow[data-id="' + CSS.escape(String(docId)) + '"]');
  if (!row) return;
  const had = row.querySelector('.wbpend');
  if (!n) {
    if (had) had.remove();
    return;
  }
  const txt = '(' + n + ' pending edit' + (n === 1 ? '' : 's') + ')';
  if (had) {
    had.textContent = txt;
    return;
  }
  const el = document.createElement('span');
  el.className = 'small wbpend';
  el.textContent = txt;
  el.title =
    'You typed in ' +
    n +
    ' field' +
    (n === 1 ? '' : 's') +
    ' of this document and have ' +
    'not saved yet. The text is safe on the server — open it and press Save to make it a ' +
    'revision, or ↺ Revert changes to throw it away.';
  // Before the spacer, which is what pushes the buttons to the right-hand end of the row.
  const spacer = row.querySelector('div[style*="flex:1"]');
  row.insertBefore(el, spacer || row.querySelector('button'));
}
/**
 * @param {string} kind
 * @param {Element} lab - the `.wbsf` control's own `<label>`.
 */
export async function wbSaveSetDraft(kind, lab) {
  const st = wbState(kind);
  if (!st.doc || !st.rev || !st.fields) return;
  const box = /** @type {HTMLElement|null} */ (lab.closest('.wbfield'));
  /** @type {WbField[]} */
  const fields = st.fields;
  const f = box && fields[+(/** @type {string} */ (box.dataset.i))],
    spec = wbSetSpec(kind, /** @type {string} */ (/** @type {HTMLElement} */ (lab).dataset.name));
  if (!f || !spec || !f.entry) return;
  // Pinned before the await for `wbSaveDraft`'s reason — a blur landing across a document switch
  // resolved its index against the NEXT document's field list and filed under the wrong locator.
  const seq = wbGen(kind),
    docId = st.doc.id,
    revN = st.rev.n;
  const now = wbSetRead(lab, spec);
  // WB_SET_SKIP is "this control is empty and its field is not nullable" — a half-typed `order` is
  // not an edit and must not be stashed as one. Leaving any earlier draft alone is deliberate: the
  // box being momentarily blank is not him withdrawing the change.
  if (now === WB_SET_SKIP) return;
  const loc = wbSetLoc(f, spec.name),
    key = JSON.stringify(loc);
  // Back to what the revision says → clear it, the same rule the body path uses, so reopening
  // never "restores" a value identical to the content and marks it dirty for nothing.
  // ⚠️ `JSON.stringify`, NOT `wbJson` — the latter answers `'~absent'` for `undefined`, which is a
  // comparison sentinel and not parseable JSON. `wbSetRead` cannot return `undefined`, so this is
  // a distinction without a difference today and a silently unrestorable draft the day it is not.
  const text = wbSetSame(now, wbRawAt(st.rev.content, loc)) ? null : JSON.stringify(now);
  if (st.draftAt && st.draftAt[key] === text) return; // nothing new
  try {
    const res = await jput(`/wbedit/documents/${encodeURIComponent(docId)}/draft`, {
      revision: revN,
      locator: loc,
      text,
    });
    wbSyncRowPending(kind, docId, +res.pending || 0);
    if (wbStale(kind, seq)) return;
    st.draftAt[key] = text;
  } catch (e) {
    wbSay(kind, 'could not stash the pending edit — it is still in the box, and Save still works', true);
  }
}
// The locator walk, browser side. Same tuple as the server's — a compiled lorebook's `entries`
// is a dict keyed by the STRING "3" and a section chunk's is a list indexed by the INT 3, and
// `node[k]` means the right thing to both, which is why the walk is untyped there too.
/**
 * @param {unknown} doc - `st.rev.content`: a worldbook or card JSON tree, dict and list nodes
 *   both, walked by the same loop — see the comment above.
 * @param {(string|number)[]} loc
 * @returns {string}
 */
export function wbGetAt(doc, loc) {
  // 🔴 `any` HERE, NOT A LIE — the walk's whole point is that ONE loop indexes both a dict
  // (string key) and a list (int key) correctly, which TypeScript has no honest way to express
  // for an accumulator whose node type changes at every step. The function's boundary stays
  // real: `doc` in as `unknown`, a `string` out.
  /** @type {any} */
  let n = doc;
  for (const k of loc) n = n[k];
  return n == null ? '' : String(n);
}
// 🔴 SAVE IS GATED ON `latest`, THE SAME WAY ROLLBACK ALWAYS WAS — the revision-conflict guard.
//
// Only `wbRollback` was ever gated on `n === doc.latest`; Save was wired unconditionally. So
// viewing revision 2 of a seven-revision book, fixing one typo and pressing Save made the new
// head *revision 2 plus that typo* — revisions 3 through 7 dropped out of it silently, with no
// warning and no confirmation. The server now refuses that with a 409 (`RevisionConflict`), and
// this is the half that stops him ever posing the question: an older revision is READ-ONLY, and
// the way to change it is the Rollback button sitting right there, which mints a new head
// honestly and keeps the history.
//
// ⚠️ DISABLED, NEVER HIDDEN — the same rule §9a.27 sets for the top-row button. Hiding it would
// move the row under the cursor exactly when he is reaching for it.
/**
 * @param {string} kind
 * @param {boolean} onLatest
 */
export function wbSaveGate(kind, onLatest) {
  // §9a.27 — remembered, because the TOP button has to answer the same question and is repainted
  // on every keystroke, long after the revision was chosen.
  wbState(kind).onLatest = !!onLatest;
  const b = /** @type {HTMLButtonElement} */ (wbEl(kind, 'wbSave')),
    hint = wbEl(kind, 'wbSaveHint');
  if (b) b.disabled = !onLatest;
  if (hint)
    hint.textContent = onLatest
      ? 'Edited by hand — saving mints a new revision.'
      : 'This is an older revision, so it cannot be saved over. Use ↺ Roll back to this to make it current.';
}
// ── §9a.27 / §9a.30: the two Save controls, decided in ONE place ─────────────────────────────
//
// Keep both Save controls on the same handler and painter so their state and revision behavior
// cannot drift apart.
/** @param {string} kind */
export function wbSaveShow(kind) {
  const host = /** @type {VEl} */ (wbEl(kind, 'wbFields'));
  const dirty = !!(host && host.querySelector('.wbdirty'));
  const wrap = /** @type {VEl} */ (wbEl(kind, 'wbSaveWrap'));
  if (wrap) wrap.style.display = dirty ? '' : 'none';
  const top = /** @type {HTMLButtonElement} */ (wbEl(kind, 'wbSaveTop'));
  // Revert follows the top Save control's layout rule: it remains rendered and is disabled when
  // there is nothing to undo, keeping the toolbar geometry stable.
  //
  // ⚠️ `draftTotal` IS IN THE TEST, NOT JUST `dirty`. A draft stranded against an older revision
  // restores nothing, so the editor is clean and `dirty` is false — and that is precisely the
  // state where reverting is the only thing left to do with it. Gating on `dirty` alone would gray
  // out the one control that can clear the roster's orange count.
  const rev = /** @type {HTMLButtonElement} */ (wbEl(kind, 'wbRevertTop'));
  if (rev && !(top && top.dataset.label)) {
    const stranded = (wbState(kind).draftTotal || 0) > 0;
    rev.disabled = !(dirty || stranded);
    rev.title = dirty
      ? 'Throw away every unsaved edit in this document and go back to the revision as it is stored. Asks first.'
      : stranded
        ? 'This document has unsaved edits typed against an earlier revision, so they cannot be shown here. Reverting is the only thing left to do with them.'
        : 'Nothing to revert — no unsaved edits.';
  }
  // ⚠️ `dataset.label` means a save is IN FLIGHT (§9a.30 stashed the caption there). Repainting
  // then would re-enable the button under his cursor mid-request, which is the double-revision
  // this milestone exists to prevent.
  if (!top || top.dataset.label) return;
  const latest = wbState(kind).onLatest !== false;
  top.disabled = !dirty || !latest;
  top.title = !latest
    ? 'This is an older revision, so it cannot be saved over. Use ↺ Roll back to this to make it current.'
    : dirty
      ? 'Save your hand edits as a new revision inside Vocalis. Nothing is sent to SillyTavern.'
      : 'Nothing to save — no hand edits yet. Type in a field and this lights up.';
}
// Disable both Save controls while a request is in flight. Two seconds of a live button is
// two seconds in which a second click mints a SECOND revision. Shipping only the spinner would
// leave the real defect behind a nicer animation.
//
// ⚠️ BOTH controls are disabled, not just the pressed one — they are the same action, and the
// whole point of §9a.27 is that there are now two ways to fire it. Only the pressed one spins:
// a spinner on a button he did not touch reads as a second thing happening.
/**
 * @param {string} kind
 * @param {boolean} on
 * @param {Element|null} [btn] - the button actually pressed; only it gets the spinner.
 */
export function wbSaveBusy(kind, on, btn) {
  /** @type {HTMLButtonElement[]} */ ([wbEl(kind, 'wbSave'), wbEl(kind, 'wbSaveTop')]).forEach(b => {
    if (!b) return;
    if (on) {
      if (b.dataset.label === undefined) b.dataset.label = b.innerHTML;
      b.disabled = true;
      if (b === btn) b.innerHTML = '<span class="spin"></span> Saving…';
    } else if (b.dataset.label !== undefined) {
      b.innerHTML = b.dataset.label;
      delete b.dataset.label;
      b.disabled = false;
    }
  });
  // 📌 Restored through the normal painter rather than by hand, so a save that FAILED lands back
  // in exactly the state the document deserves — still dirty, still offering both buttons — and a
  // save that succeeded lands clean. A control left spinning after a 423 is worse than no spinner.
  if (!on) {
    wbSaveGate(kind, wbState(kind).onLatest !== false);
    wbSaveShow(kind);
  }
}
/**
 * @param {string} kind
 * @param {Element} ta - the field's `<textarea>`.
 */
export function wbMarkDirty(kind, ta) {
  const box = /** @type {HTMLElement} */ (ta.closest('.wbfield'));
  const i = +(/** @type {string} */ (/** @type {HTMLTextAreaElement} */ (ta).dataset.i));
  /** @type {WbField[]} */
  const fields = wbState(kind).fields;
  const original = wbGetAt(wbState(kind).rev.content, fields[i].locator);
  // The row is dirty when either the body or a setting differs from the loaded revision.
  box.classList.toggle('wbdirty', /** @type {HTMLTextAreaElement} */ (ta).value !== original || !!box.querySelector('.wbsf.dirty'));
  wbSaveShow(kind); // §9a.27 — one painter for BOTH Save controls
}
// ── m4y / §9a.4: an entry's INJECTION MODE, which is the thing he reads first ────────────────
//
// The marker communicates whether an entry is injected on every message, which affects token use.
//
// 🔴 FOUR STATES, NOT TWO, CONFIRMED AGAINST THE FORK'S SOURCE (`public/scripts/world-info.js`)
// RATHER THAN ASSUMED — the design doc required exactly that before choosing colors. `:3406` is a
// tri-state (`constant` / `vectorized` / `normal`) and `:4952` shows `disable` is orthogonal and
// checked first, so it wins. ⚠️ Rendering a DISABLED entry green as "normal" would be a lie about a
// book that is injecting nothing: it is present, it has keywords, it costs nothing and does
// nothing. `wbedit/formats/worldbook.py:entry_mode` does the same ordering server-side.
//
// 🔴 THE COLOR IS NEVER THE ONLY CARRIER. The `title` is the real answer; `vectorized` and
// `disabled` also get their own glyph, so the two states most likely to be misread do not depend on
// telling violet from blue or gray from green.
// Match SillyTavern's established glyphs so users see the same injection-mode language in both
// editors.
//
// Taken verbatim from the fork's `entryStateSelector` (`public/index.html:7271`), which is the
// authority for what these three states look like to him everywhere else:
//     <option value="constant">🔵</option> <option value="normal">🟢</option>
//     <option value="vectorized">🔗</option>
// `tests/test_wbedit_modeglyphs.py` pins all three
// against the fork and fails by name if it changes one.
//
// ⚠️ `disabled` IS NOT IN THAT SELECT, and that is a fact about the fork's model rather than an
// omission: SillyTavern treats disable as an orthogonal toggle (`fa-comment-slash`, "Temporarily
// disable") and derives "normal" from none of the three boxes being ticked. So ⛔ is ours by
// necessity — chosen to read as *stopped* rather than as a fourth injection mode.
//
// 🔴 CONSTANT AND NORMAL USED TO BE THE SAME GLYPH IN TWO COLORS (`●` in --acc and --ok), which
// is the specific thing that was wrong: unreadable at a glance, and useless to anyone who cannot
// separate those two hues. The fork's set is glyph-distinct AS WELL AS color-distinct, which is
// the real reason to take it wholesale instead of just recoloring ours.
export const WB_MODES = {
  constant: {
    glyph: '🔵',
    tip: 'Always injected — this entry is in EVERY prompt, no keyword needed. It costs its tokens on every single message.',
  },
  normal: {
    glyph: '🟢',
    tip: 'Normal — injected only when one of its keywords matches the recent conversation.',
  },
  vectorized: {
    glyph: '🔗',
    tip: 'Vectorized — retrieved by similarity rather than by keyword match.',
  },
  disabled: {
    glyph: '⛔',
    tip: 'Disabled — SillyTavern skips this entry entirely. It is never injected, by keyword or otherwise.',
  },
};
/**
 * @param {string|undefined} mode
 * @returns {{glyph: string, tip: string}|null}
 */
export function wbMode(mode) {
  return WB_MODES[/** @type {keyof typeof WB_MODES} */ (mode)] || null;
}
// ── m5g / §9a.26: the typed field renderer ───────────────────────────────────────────────────
//
// Until now every editable thing in this product was ONE STRING, at one locator, rendered as one
// `<textarea>`. A worldbook entry has 38 fields and exactly one of them is prose, so the deliverable
// was never "add sticky" — it was a renderer that can draw a boolean, an integer, an enum, an array
// and a NULLABLE number, after which sticky is nine lines of table.
//
// `null` is not `0`: `sticky: null` means *not set —
// inherit the global*; `sticky: 0` means *explicitly none*. A number box that renders null as empty
// and writes back 0 changes every entry it is opened over, across a whole book, in a save he did not
// know he was making. `wbSetRead` returns `null` for an empty nullable box and `undefined` for
// "leave this alone", and `wbSetSame` compares with JSON rather than `==` so that `0`, `false`,
// `null` and absent stay four distinct answers all the way to the wire.
//
// 🔴 **THE BODY IS BUILT ON FIRST OPEN, NEVER WITH THE ROW.** A 110-entry book times 37 controls is
// four thousand DOM nodes, most of which are checkboxes nobody will look at, and paying for them on
// every document open would make the pane that already works feel broken. The toggle is the render.
// ⚠️ A SYMBOL, AND `'~absent'` BELOW, BECAUSE THE FIRST DRAFT OF BOTH USED A NUL-PREFIXED STRING
// AND PUT TWO LITERAL NUL BYTES INTO THIS FILE. That is precisely what
// `test_no_nul_byte_reaches_the_draft_file_or_the_web_ui` exists to catch, and its docstring
// describes the symptom exactly: the page still renders, the suite stays green, and hours later
// `grep` quietly decides index.html is binary and refuses to search it — so the tool you reach
// for to find the problem is the tool that has stopped working. A Symbol cannot collide with any
// value, and `JSON.stringify` can never return `~absent` (a string comes back quoted).
export const WB_SET_SKIP = Symbol('wb-set-skip');
/**
 * @param {unknown} doc - see `wbGetAt`'s note on why the walk itself stays untyped.
 * @param {(string|number)[]} loc
 * @returns {unknown} the raw value — a bool, a number, `null`, a string, or `undefined` when
 *   the key is absent (an older book predating a field the server has since added).
 */
export function wbRawAt(doc, loc) {
  // The untyped sibling of `wbGetAt`, which coerces to String for the textareas. A setting is a
  // boolean or a number or null and must arrive as itself; `undefined` means the key is absent,
  // which is ordinary — books swept out of SillyTavern predate fields it has since added.
  /** @type {any} */
  let n = doc;
  for (const k of loc) {
    if (n == null) return undefined;
    n = n[k];
  }
  return n;
}
/** @param {unknown} v @returns {string} */
export function wbJson(v) {
  return v === undefined ? '~absent' : JSON.stringify(v);
}
/** @param {unknown} a @param {unknown} b */
export function wbSetSame(a, b) {
  return wbJson(a) === wbJson(b);
}
/**
 * @param {WbField} f - must carry `.entry` (a setting has no locator otherwise).
 * @param {string} name
 * @returns {(string|number)[]}
 */
export function wbSetLoc(f, name) {
  return /** @type {(string|number)[]} */ (f.entry).concat([name]);
}
// One control's markup. `data-name` is the field, `data-i` the row it belongs to; both are read
// back by `wbSetRead` and by the save.
/**
 * @param {WbSettingSpec} spec
 * @param {unknown} value - the field's current value for this setting; a bool, number, string,
 *   array or `null` depending on `spec.type`.
 * @returns {string}
 */
export function wbSetControl(spec, value) {
  const t = spec.type,
    id = esc(spec.name);
  /**
   * @param {string} inner
   * @param {string} [cls]
   */
  const box = (inner, cls) =>
    `<label class="wbsf ${cls || ''}" data-name="${id}">` +
    `<span class="wbsl" title="${esc(spec.tip || spec.label)}">${esc(spec.label)}</span>` +
    inner +
    `</label>`;

  if (t === 'bool') {
    return (
      `<label class="wbsf check" data-name="${id}" title="${esc(spec.tip || spec.label)}">` +
      `<input type="checkbox" class="wbsv" data-name="${id}"${value === true ? ' checked' : ''}>` +
      `<span class="wbsl">${esc(spec.label)}</span></label>`
    );
  }
  if (t === 'bool?' || t === 'enum' || t === 'enum?') {
    // 🔴 THE OPTION VALUE IS JSON, NOT THE RAW NUMBER. `value="null"` and `value="0"` are both
    // strings in the DOM, and `parseInt` cannot tell "use global" from "System". JSON round-trips
    // null, true, false and integers through one parse with no per-type branch to get wrong.
    const opts = (spec.options || [])
      .map(
        o => `<option value="${esc(JSON.stringify(o.value))}"` + `${wbSetSame(o.value, value) ? ' selected' : ''}>${esc(o.label)}</option>`,
      )
      .join('');
    return box(`<select class="wbsv" data-name="${id}">${opts}</select>`);
  }
  if (t === 'int' || t === 'int?') {
    const v = typeof value === 'number' ? String(value) : '';
    const mn = spec.min == null ? '' : ` min="${spec.min}"`;
    const mx = spec.max == null ? '' : ` max="${spec.max}"`;
    return box(
      `<input type="number" class="wbsv" data-name="${id}" value="${esc(v)}"${mn}${mx}` + ` placeholder="${esc(spec.placeholder || '')}">`,
    );
  }
  if (t === 'array') {
    // Comma separated, exactly as SillyTavern's own plaintext mode for `key` — same separator, so
    // a list copied between the two products means the same thing in both.
    const v = Array.isArray(value) ? value.join(', ') : '';
    return box(
      `<input type="text" class="wbsv" data-name="${id}" value="${esc(v)}"` + ` placeholder="${esc(spec.placeholder || '')}">`,
      'wide',
    );
  }
  if (t === 'boolint') {
    // The fork's own union (`world-info.js:3875`): false is off, true is level 1, a number is that
    // level. Two controls writing one key, which is how SillyTavern draws it too.
    const on = value === true || (typeof value === 'number' && value > 0);
    const lvl = typeof value === 'number' ? String(value) : '';
    return (
      `<label class="wbsf wide" data-name="${id}">` +
      `<span class="wbsl" title="${esc(spec.tip || spec.label)}">${esc(spec.label)}</span>` +
      `<span class="wbsub"><input type="checkbox" class="wbsv" data-name="${id}"` +
      `${on ? ' checked' : ''}>` +
      `<input type="number" class="wbsv2" data-name="${id}" value="${esc(lvl)}"` +
      ` placeholder="${esc(spec.placeholder || '1')}" min="${spec.min == null ? 1 : spec.min}">` +
      `</span></label>`
    );
  }
  // string / text
  const v = typeof value === 'string' ? value : '';
  return box(
    `<input type="text" class="wbsv" data-name="${id}" value="${esc(v)}"` + ` placeholder="${esc(spec.placeholder || '')}">`,
    'wide',
  );
}
// What a control currently says, as the value that would be WRITTEN. `WB_SET_SKIP` means "this
// control is empty and its field is not nullable" — a blank `order` box must not become an edit.
/**
 * @param {Element} lab - the control's `.wbsf` `<label>`.
 * @param {WbSettingSpec} spec
 * @returns {unknown} - `WB_SET_SKIP`, or the value the control would write.
 */
export function wbSetRead(lab, spec) {
  const t = spec.type,
    el = lab.querySelector('.wbsv');
  if (t === 'bool') return !!(/** @type {HTMLInputElement} */ (el).checked);
  if (t === 'bool?' || t === 'enum' || t === 'enum?') {
    try {
      return JSON.parse(/** @type {HTMLSelectElement} */ (el).value);
    } catch (_) {
      return WB_SET_SKIP;
    }
  }
  if (t === 'int' || t === 'int?') {
    const s = /** @type {HTMLInputElement} */ (el).value.trim();
    if (s === '') return t === 'int?' ? null : WB_SET_SKIP;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : WB_SET_SKIP;
  }
  if (t === 'array') {
    return /** @type {HTMLInputElement} */ (el).value
      .split(',')
      .map(s => s.trim())
      .filter(s => s !== '');
  }
  if (t === 'boolint') {
    if (!(/** @type {HTMLInputElement} */ (el).checked)) return false;
    const s = /** @type {HTMLInputElement} */ (lab.querySelector('.wbsv2')).value.trim();
    if (s === '') return true;
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : true;
  }
  return /** @type {HTMLInputElement} */ (el).value;
}
/**
 * @param {string} kind
 * @param {string} name
 * @returns {WbSettingSpec}
 */
export function wbSetSpec(kind, name) {
  return (wbState(kind).specByName || {})[name];
}
// 🔴 **ONLY WHAT HE ACTUALLY TOUCHED IS PROPOSED, AND "DIFFERENT FROM WHAT IS STORED" IS NOT THE
// SAME TEST.** Found by `test_the_editor_tab_works_in_a_real_browser` before this shipped: merely
// OPENING the fold on a book swept out of SillyTavern proposed **28 edits**, because most of the 38
// keys are simply absent from a real entry and an untouched control still has to render as
// something — an unticked checkbox reads back `false`, a select sits on its first option. Every one
// of those differs from "absent", so a save made for an unrelated reason would have written 28
// fields into an entry he only glanced at. That is the whole failure this milestone exists to
// prevent, arriving through a door the tri-state rule does not cover.
//
// The flag is set by the input handler, so it means "he moved this control" and nothing else. A
// rebuild (every `wbOpen`, including the one a save does) clears it, which is correct: the values
// are freshly read from the new revision and nothing is pending again.
/** @param {Element} lab */
export function wbSetTouched(lab) {
  /** @type {HTMLElement} */ (lab).dataset.touched = '1';
}
// Repaint one control's dirty mark and the row's, then the Save button. Called on every input.
/**
 * @param {string} kind
 * @param {Element} lab - the control's `.wbsf` `<label>`.
 */
export function wbSetDirty(kind, lab) {
  const st = wbState(kind),
    box = /** @type {HTMLElement} */ (lab.closest('.wbfield')),
    i = +(/** @type {string} */ (box.dataset.i));
  /** @type {WbField[]} */
  const fields = st.fields;
  const f = fields[i],
    spec = wbSetSpec(kind, /** @type {string} */ (/** @type {HTMLElement} */ (lab).dataset.name));
  if (!f || !spec || !f.entry) return;
  const now = wbSetRead(lab, spec);
  const was = wbRawAt(st.rev.content, wbSetLoc(f, spec.name));
  const changed = now !== WB_SET_SKIP && !wbSetSame(now, was);
  lab.classList.toggle('dirty', changed);
  // The row is dirty if its textarea is, or ANY of its settings are. Recomputed from the DOM
  // rather than tracked, so a control edited back to its original value clears the row too.
  const ta = box.querySelector('.wbtext');
  const taDirty = ta && /** @type {HTMLTextAreaElement} */ (ta).value !== wbGetAt(st.rev.content, f.locator);
  box.classList.toggle('wbdirty', !!taDirty || !!box.querySelector('.wbsf.dirty'));
  wbSaveShow(kind); // §9a.27 — one painter for BOTH Save controls
}
//: §9a.35 — the ONE entry setting that is not optional, and is therefore not in the fold.
//
// A save is refused for a non-constant entry with no keywords, so `key` is not a setting — it is the second
// half of the entry, next to its text. Everything else in the fold has a working default; this one
// has none, and a mandatory field behind a disclosure control is a form that hides its own
// requirement until the server says no. Auto-expanding on ✚ Add entry would fix only the entry he
// just made, and leave every imported keyless entry exactly as hidden as before.
export const WB_KEY_FIELD = 'key';

/**
 * The shared body renderer. Two callers: the always-visible keywords box and the ⚙ fold — one
 * implementation, because the draping of drafts, the touched-restore and the four event bindings
 * below are the parts that are easy to get subtly different and impossible to notice.
 *
 * @param {string} kind
 * @param {Element} box - the `.wbfield` row.
 * @param {HTMLElement|null} body - the container to fill.
 * @param {(name: string) => boolean} want - which specs belong in this body.
 * @param {boolean} grouped - draw the group headings (the fold) or not (one hoisted row).
 */
function wbSetFill(kind, box, body, want, grouped) {
  const st = wbState(kind),
    i = +(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i));
  /** @type {WbField[]} */
  const fields = st.fields;
  const f = fields[i];
  if (!f || !f.entry || !body || body.dataset.built) return;
  const entry = /** @type {Record<string, unknown>} */ (wbRawAt(st.rev.content, f.entry) || {});
  // 🔴 7.3.9c — THE FOLD IS BUILT FROM THE REVISION *WITH THE PENDING EDITS DRAPED OVER IT*, which
  // is the same thing `wbRestoreDrafts` does to the textareas and for the same reason. Building
  // from the revision alone would show him the OLD keywords under a row marked dirty, and — far
  // worse — `wbSetEdits` reads the DOM at Save time, so the stale value is what would have been
  // written. Draping here rather than patching afterward means a fold built now, built after a
  // reload, or built ten minutes from now all show the same thing.
  /** @type {Set<string>} */
  const drafted = new Set();
  /** @param {WbSettingSpec} s */
  const withDraft = s => {
    const d = (st.draftAt || {})[wbDraftSetKey(f, s.name)];
    if (d == null) return entry[s.name]; // no draft (or one that was cleared)
    try {
      const v = JSON.parse(d);
      drafted.add(s.name);
      return v;
    } catch (_) {
      return entry[s.name];
    } // a body-text draft under a colliding locator
  };
  /** @type {WbSettingGroup[]} */
  const specGroups = st.specGroups || [];
  /** @type {WbSettingSpec[]} */
  const spec = st.spec || [];
  // ⚠️ THE HOISTED BOX IS DRAWN UNGROUPED, and that is not cosmetics. A lone "IDENTITY" heading
  // over one control would say the box is a section of the settings, which is the reading §9a.35
  // exists to remove: keywords are part of the ENTRY, and the fold is where the options live.
  const html = grouped
    ? specGroups
        .map(g => {
          const rows = spec
            .filter(s => s.group === g.key && want(s.name))
            .map(s => wbSetControl(s, withDraft(s)))
            .join('');
          if (!rows) return '';
          return `<div class="wbsetgrp"><h5>${esc(g.label)}</h5><div class="wbsetrow">${rows}</div></div>`;
        })
        .join('')
    : `<div class="wbsetrow">${spec
        .filter(s => want(s.name))
        .map(s => wbSetControl(s, withDraft(s)))
        .join('')}</div>`;
  body.innerHTML = html;
  body.dataset.built = '1';
  body.querySelectorAll('.wbsf').forEach(lab => {
    lab.querySelectorAll('.wbsv, .wbsv2').forEach(el => {
      const hit = () => {
        wbSetTouched(lab);
        wbSetDirty(kind, lab);
      };
      el.addEventListener('input', hit);
      el.addEventListener('change', hit);
      // 7.3.9c — the stash, on the two events that mean "he stopped changing it". See
      // `wbSaveSetDraft`: deliberately NOT on `input`.
      el.addEventListener('change', () => wbSaveSetDraft(kind, lab));
      el.addEventListener('blur', () => wbSaveSetDraft(kind, lab));
    });
    // 🔴 A RESTORED CONTROL MUST BE MARKED TOUCHED, OR SAVE SILENTLY DROPS IT. `wbSetEdits` reads
    // only `.wbsf[data-touched]` inside a `[data-built]` body — the rule that stops a fold he
    // merely looked at proposing 28 edits. A draft IS him having touched it, on an earlier visit,
    // so the flag has to be re-asserted here or the pending value is visible, dirty, and unsaveable.
    if (drafted.has(/** @type {string} */ (/** @type {HTMLElement} */ (lab).dataset.name))) {
      wbSetTouched(lab);
      wbSetDirty(kind, lab);
    }
  });
}
/**
 * The ⚙ fold — everything EXCEPT the primary keywords, which now sit above it (§9a.35).
 *
 * 🔴 `:not(.wbkeysbody)` IS LOAD-BEARING. Both bodies carry `.wbsetbody`, deliberately, so that
 * `wbSetEdits`, `wbSetTouched` and the draft stash reach the hoisted control without a second
 * code path — which means a bare `.wbsetbody` lookup here would find the keywords box first (it
 * is the earlier sibling) and fill it with the whole fold.
 *
 * @param {string} kind
 * @param {Element} box - the `.wbfield` row.
 */
export function wbSetBuild(kind, box) {
  wbSetFill(kind, box, /** @type {HTMLElement|null} */ (box.querySelector('.wbsetbody:not(.wbkeysbody)')), n => n !== WB_KEY_FIELD, true);
}
/**
 * §9a.35 — the always-visible primary keywords box, above the fold. Built EAGERLY, unlike the
 * fold: "always show them" is the whole request, and a lazily-built always-visible control is a
 * contradiction. It is one text input per entry, not the fold's 38 controls, so §9a.31's
 * page-height argument for laziness does not reach it.
 *
 * @param {string} kind
 * @param {Element} box - the `.wbfield` row.
 */
export function wbKeysBuild(kind, box) {
  wbSetFill(kind, box, /** @type {HTMLElement|null} */ (box.querySelector('.wbkeysbody')), n => n === WB_KEY_FIELD, false);
}
/**
 * @param {string} kind
 * @param {Element} box - the `.wbfield` row.
 */
export function wbSetToggle(kind, box) {
  const st = wbState(kind),
    i = +(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i));
  // 🔴 `:not(.wbkeysbody)` — §9a.35 put a SECOND `.wbsetbody` on this row, and it is the FIRST
  // child, so a bare lookup here toggles `hidden` on the always-visible keywords box and leaves
  // the ⚙ pane shut. The class is shared on purpose (`wbSetEdits` and the draft stash reach both
  // through it); every lookup that means "the fold specifically" has to say so.
  const body = /** @type {Element} */ (box.querySelector('.wbsetbody:not(.wbkeysbody)')),
    tog = /** @type {Element} */ (box.querySelector('.wbsetog'));
  const open = body.hasAttribute('hidden');
  if (open) wbSetBuild(kind, box);
  body.toggleAttribute('hidden', !open);
  tog.classList.toggle('on', open);
  st.setOpen = st.setOpen || new Set();
  if (open) st.setOpen.add(i);
  else st.setOpen.delete(i);
}
// §9a.29a — mark the entries the server refused, and put the fix on screen.
//
// 🔴 MATCHED ON THE ENTRY LOCATOR, NEVER ON THE LABEL. A worldbook `comment` is optional and not
// unique — two entries can share a label — so matching on the
// displayed name would paint the wrong row red and leave the real one saveable-looking.
//
// ⚠️ Clears every previous mark first: an entry he has since fixed must stop being red without a
// reload, or the pane accumulates warnings about problems that are gone.
/**
 * @param {string} kind
 * @param {{entry?: (string|number)[]}[]} entries - the 422's own list of refused entries, e.g.
 *   `e.body.entries` (see `HttpErrorBody`), matched by LOCATOR — never by label (see below).
 */
export function wbMarkKeyless(kind, entries) {
  const st = wbState(kind),
    host = wbEl(kind, 'wbFields');
  if (!host) return;
  host.querySelectorAll('.wbfield.wbkeyless').forEach(b => b.classList.remove('wbkeyless'));
  const want = new Set((entries || []).map(e => JSON.stringify(e.entry || [])));
  /** @type {Element|null} */
  let first = null; // inferred from `null` alone this narrows to `never` and .scrollIntoView vanishes
  /** @type {WbField[]} */
  const fields = st.fields;
  host.querySelectorAll('.wbfield').forEach(box => {
    const f = fields[+(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i))];
    if (!f || !f.entry) return;
    if (!want.has(JSON.stringify(f.entry))) return;
    box.classList.add('wbkeyless');
    // 🔴 §9a.31 — UN-SHUT IT FIRST. The accordion hides `.wbset` as well as the body, so on a
    // collapsed entry the ⚙ fold below would be opened and still invisible: a refusal pointing at
    // a control that is not on screen, which is the precise failure this marking exists to avoid.
    // Only the offenders, never all of them — §9a.31 is about the page being too tall already.
    wbShutToggle(kind, box, false);
    // 🔴 §9a.35 — THE FOLD IS NO LONGER OPENED HERE, AND THAT IS THE FIX RATHER THAN A DELETION.
    // This used to open the ⚙ pane because the Keywords box lived inside it (m5g), so a refusal
    // that did not open it pointed at a control he could not see. Keywords are now above the
    // fold and always on screen, so un-shutting the accordion above is the whole of what this
    // needs — and opening the fold as well would dump 38 controls under every refused entry to
    // reveal one that was already visible.
    if (!first) first = box;
  });
  // ⚠️ Scroll, do NOT focus. Stealing the caret out of whatever textarea he was typing in is the
  // §9a.24 mistake (the add-entry flow was fixed once for exactly this), and he may well be
  // mid-sentence in a different entry when the save is refused.
  if (first) /** @type {Element} */ (first).scrollIntoView({ block: 'center', behavior: 'smooth' });
}
// Every settings edit on screen, as `{locator, value}` for the edit route.
//
// Two gates, and both are load-bearing. Only BUILT bodies are walked — a fold never opened cannot
// have been changed, and reading it would mean rendering it. And within a built body only TOUCHED
// controls are read: see `wbSetTouched` for the 28-edits bug that rule exists to stop.
/**
 * @param {string} kind
 * @returns {{locator: (string|number)[], value: unknown, label: string}[]}
 */
export function wbSetEdits(kind) {
  const st = wbState(kind);
  /** @type {{locator: (string|number)[], value: unknown, label: string}[]} */
  const out = [];
  /** @type {WbField[]} */
  const fields = st.fields;
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbsetbody[data-built]').forEach(body => {
    const box = /** @type {HTMLElement} */ (body.closest('.wbfield')),
      f = fields[+(/** @type {string} */ (box.dataset.i))];
    if (!f || !f.entry) return;
    body.querySelectorAll('.wbsf[data-touched]').forEach(lab => {
      const spec = wbSetSpec(kind, /** @type {string} */ (/** @type {HTMLElement} */ (lab).dataset.name));
      if (!spec) return;
      const now = wbSetRead(lab, spec);
      if (now === WB_SET_SKIP) return;
      const loc = wbSetLoc(f, spec.name);
      if (wbSetSame(now, wbRawAt(st.rev.content, loc))) return;
      out.push({ locator: loc, value: now, label: f.label + ' · ' + spec.label });
    });
  });
  return out;
}
// Which injection mode the open book's entry list is narrowed to, per kind. '' is All.
//
// ⚠️ THIS IS A DIFFERENT CONTROL FROM §8.2's WORLDBOOK FILTER, which narrows which CARDS the
// Library lists. This one narrows the ENTRIES inside the book already open, so both labels have to
// say which is which — two filters on one page that read alike is a way to act on the wrong one.
export const wbModeFilter = {};
/** @param {string} kind */
export function wbFilterPaint(kind) {
  const host = /** @type {VEl} */ (wbEl(kind, 'wbFields'));
  if (!host) return;
  // ⚠️ `wbModeFilter` STAYS UNTYPED HERE, DELIBERATELY — `wire.js` and `open.js` already cast at
  // their own use sites (search `Record<string, string>`) rather than pin a shape in this file
  // for an object every one of them mutates; matching that pattern here rather than picking a
  // different one.
  const want = /** @type {Record<string, string>} */ (wbModeFilter)[kind] || '';
  /** @type {NodeListOf<HTMLElement>} */ (host.querySelectorAll('.wbfield')).forEach(box => {
    box.classList.toggle('wbhide', !!want && (box.dataset.mode || '') !== want);
  });
  // 🔴 m4k / §9a.5 — A HEADING WITH NOTHING LEFT UNDER IT MUST GO TOO. The m4y mode filter hides
  // `.wbfield` rows, and a card's embedded lorebook is exactly the kind of small group that gets
  // emptied by one — leaving "Lorebook inside this card" floating over the next section's fields
  // and labeling them, which is a worse lie than the label this heading was added to fix.
  //
  // ⚠️ Walked forward from each heading rather than by counting: the heading owns everything up to
  // the NEXT heading, and `previousElementSibling` chains would have to know that too.
  const kids = [...host.children];
  kids.forEach((el, i) => {
    if (!el.classList.contains('wbgroup')) return;
    let anyVisible = false;
    for (let j = i + 1; j < kids.length; j++) {
      if (kids[j].classList.contains('wbgroup')) break;
      if (kids[j].classList.contains('wbfield') && !kids[j].classList.contains('wbhide')) {
        anyVisible = true;
        break;
      }
    }
    el.classList.toggle('wbhide', !anyVisible);
  });
}
/** @param {string} kind */
export function wbVisibleTicks(kind) {
  return /** @type {HTMLInputElement[]} */ (
    [.../** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbfield')]
      .filter(b => !b.classList.contains('wbhide'))
      .map(b => b.querySelector('.wbtick'))
      .filter(Boolean)
  );
}
/**
 * The ticks a SELECTION VERB may move — visible, and not disabled. 7.4 / §9a.32.
 *
 * 🔴 SEPARATE FROM `wbVisibleTicks` ON PURPOSE, because that one is also the preflight's
 * denominator (`st.fields.length - wbVisibleTicks(kind).length` is "hidden by the filter"). An
 * empty field is VISIBLE and merely unselectable, so counting it as hidden would print a filter
 * complaint about rows sitting on screen in front of him.
 *
 * 🔴 AND `checked = true` ON A DISABLED BOX SUCCEEDS. Disabling an input stops a human clicking
 * it; it does not stop `tick all`, `tick none` or invert from setting the property. Without this
 * filter, ⊕ tick all would select every empty field, the preflight would count them, and Run
 * would silently drop them — the server does not collect an empty field for a pass — which is the
 * visible-tickable-counted-and-dead control this pane has shipped twice before.
 */
/** @param {string} kind */
export function wbTickable(kind) {
  return wbVisibleTicks(kind).filter(c => !c.disabled);
}
// 🔴 HIDDEN IS NOT TICKED, AND THIS IS THE ONE LINE THAT KEEPS A FILTERED PASS HONEST.
//
// The design doc's rule: *"A filtered list must not silently narrow a PASS. Tick-all over a
// filtered view has to mean 'every entry I can see'"* — because otherwise he filters to
// Always-injected, presses tick all, and runs an instruction over a third of the book believing it
// covered the lot. Enforcing it HERE rather than in each caller means the preflight, the run, the
// preview picker and the estimate all agree by construction: nothing he cannot see can be in a pass.
// ⚠️ `!c.disabled` IS THE SAME GUARANTEE ONE STEP FURTHER IN — §9a.32. Nothing he cannot SEE may
// be in a pass, and nothing the server will not COLLECT for one may be either. An empty card field
// is the second case, and this is the line every consumer (preflight, Run, the preview picker, the
// estimate, Find) already reads, so they agree by construction rather than by four memories.
/**
 * @param {string} kind
 * @returns {number[]}
 */
export function wbTicked(kind) {
  /** @type {number[]} */
  const out = [];
  // 🔴 9.6.6 — AND AN INDEX WITH NO FIELD BEHIND IT IS NOT A TICK. The rows are the DOM's copy of
  // `st.fields` and the two are rendered together, so they agree for the whole life of an open
  // document — but `wbCloseEditor` empties `st.fields` and deliberately leaves `#wbFields`
  // populated, and that gap is reachable (see `wbOpen`'s note on the draft read). All three
  // consumers then trusted the index: `wbSyncPreviewPick` read `fields[i].label`, `wbPreflight`
  // read `.chars`, `wbRun` read `.locator`. Filtering here rather than in the three of them is the
  // point of the note above — they agree by construction, and that has to include this.
  /** @type {WbField[]} */
  const fields = wbState(kind).fields || [];
  /** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbfield').forEach(box => {
    if (box.classList.contains('wbhide')) return;
    const c = /** @type {HTMLInputElement|null} */ (box.querySelector('.wbtick'));
    if (!c || !c.checked || c.disabled) return;
    const i = +(/** @type {string} */ (c.dataset.i));
    if (fields[i]) out.push(i);
  });
  return out;
}
// ── m4x: the two selection verbs "tick all"/"tick none" cannot express ───────────────────────
//
// Invert selection lets a user untick one field and flip the remaining selection, making that
// field the only selected one.
// "tick all" and "tick none" are already there (`wbAll` / `wbNone`) and neither can do that: they
// are set operations, this is a per-box negation.
//
// 📌 EVERY SELECTION CHANGE MUST END IN `wbPreflight`, or the "N of M fields selected" line and the
// time estimate describe the previous selection — a stale number in front of a ~35-minute decision.
/** @param {string} kind */
export function wbInvertTicks(kind) {
  wbTickable(kind).forEach(c => {
    c.checked = !c.checked;
  });
  wbFoldPaint(kind);
  wbPreflight(kind);
}
// Which documents currently have their unticked fields folded. Per kind, because the three panes
// are three independent editors and folding books must not fold the card he has open beside it.
export const wbFolded = {};
// The header row is never removed. Hiding the
// whole `.wbfield` would take the checkbox with it, and then there is no way to tick the field back
// on: the control that undoes the hiding would be inside the thing that was hidden.
/**
 * @param {string} kind
 * @param {boolean} [on] - omitted toggles the current state.
 */
export function wbFoldUnticked(kind, on) {
  // ⚠️ `wbFolded` stays untyped here too — see `wbModeFilter`'s note above.
  const folded = /** @type {Record<string, boolean>} */ (wbFolded);
  folded[kind] = on === undefined ? !folded[kind] : !!on;
  wbFoldPaint(kind);
  const b = /** @type {VEl} */ (wbEl(kind, 'wbFold'));
  if (b) b.textContent = folded[kind] ? '⊞ show all' : '⊟ collapse unticked';
}
// Re-applied on every tick change, so ticking a folded field brings its body straight back — which
// is what makes the header row a usable control rather than a dead label.
/** @param {string} kind */
export function wbFoldPaint(kind) {
  const host = /** @type {VEl} */ (wbEl(kind, 'wbFields'));
  if (!host) return;
  host.querySelectorAll('.wbfield').forEach(box => {
    const c = /** @type {HTMLInputElement|null} */ (box.querySelector('.wbtick'));
    box.classList.toggle('wbfold', !!(/** @type {Record<string, boolean>} */ (wbFolded)[kind]) && !!c && !c.checked);
  });
}
/** @param {string} kind */
/**
 * @param {string} kind
 * @returns {Set<number>}
 */
export function wbShutRows(kind) {
  const st = wbState(kind);
  if (!st.openRows) st.openRows = new Set();
  return st.openRows;
}
/** @param {string} kind */
export function wbHasEntries(kind) {
  /** @type {WbField[]} */
  const fields = wbState(kind).fields || [];
  return fields.some(f => !!f.entry);
}
// Show entry-list controls only when a document has entries; otherwise they are dead controls
// above the empty-document message.
//
// ⚠️ Called from `wbOpen`, never from an input handler. Showing and hiding buttons in the top row
// moves the row sideways; doing it once per document is fine, doing it per keystroke is the
// mis-click generator §9a.27 refuses to build.
/** @param {string} kind */
export function wbEntryCtl(kind) {
  const on = wbHasEntries(kind);
  // §9a.28 item 2 — the mode filter goes with them, for the same reason and on the same test.
  // 9.4 — ⇊ Fix positions joins them: it rewrites the POSITION of entries, so over a
  // book with none it is the same dead control §9a.28 and §9a.31 both landed on.
  ['wbExpandAll', 'wbCollapseAll', 'wbEntryModeWrap', 'wbFixDepths'].forEach(id => {
    const b = /** @type {VEl} */ (wbEl(kind, id));
    if (b) b.style.display = on ? '' : 'none';
  });
}
// Open or shut ONE entry row, and remember which it was.
//
// 🔴 THE `f.entry` GUARD IS IN HERE SO EVERY CALLER INHERITS IT. Find reaches this with whatever
// row a hit landed in, and on a character card that is usually one of the card's OWN fields, which
// has no accordion. Recording such a row would put a non-entry index into `openRows` — and since
// `wbShutInit` reads a non-empty set as "we already know his layout", one Find on a card would
// silently cancel first-entry-open for every book opened afterward.
/**
 * @param {string} kind
 * @param {Element} box - the `.wbfield` row.
 * @param {boolean} [want] - omitted toggles the current state.
 */
export function wbShutToggle(kind, box, want) {
  const i = +(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i));
  /** @type {WbField[]} */
  const fields = wbState(kind).fields || [];
  const f = fields[i];
  if (!f || !f.entry) return;
  const shut = want === undefined ? !box.classList.contains('wbshut') : !!want;
  box.classList.toggle('wbshut', shut);
  const rows = wbShutRows(kind);
  if (shut) rows.delete(i);
  else rows.add(i);
}
/**
 * @param {string} kind
 * @param {boolean} [on]
 */
export function wbShutAll(kind, on) {
  const host = /** @type {VEl} */ (wbEl(kind, 'wbFields'));
  if (!host) return;
  const st = wbState(kind);
  /** @type {WbField[]} */
  const fields = st.fields;
  host.querySelectorAll('.wbfield').forEach(box => {
    const f = fields[+(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i))];
    if (!f || !f.entry) return; // a card's own fields are never folded — §6.1.2
    wbShutToggle(kind, box, on);
  });
}
// The state the rows are born in, re-asserted after every render.
//
// 🔴 "FIRST ENTRY OPEN, THE REST SHUT" IS THE STATE FOR A DOCUMENT HE HAS JUST SELECTED — not for
// every render. `wbOpen` also runs after a SAVE (that is how the new revision reaches the screen)
// and after picking a revision, and slamming shut the six entries he had just arranged is the same
// "it threw away my place" failure that m5g's `st.setOpen` restore and the scroll restore both
// exist to prevent. So: restore what he had open if we have it, and fall back to first-open only
// when this is genuinely a document we have not shown yet. `st.openRows` is cleared in `wbOpen`
// on an id change, exactly like `st.setOpen`.
//
// ⚠️ The first ENTRY, which on a character card is not the first field. A card's own prose rows
// have no accordion at all, so "the first one" has to be counted over entries.
/** @param {string} kind */
export function wbShutInit(kind) {
  const host = /** @type {VEl} */ (wbEl(kind, 'wbFields')),
    st = wbState(kind);
  if (!host) return;
  const rows = wbShutRows(kind);
  const known = rows.size > 0;
  let seen = 0;
  /** @type {WbField[]} */
  const fields = st.fields;
  host.querySelectorAll('.wbfield').forEach(box => {
    const f = fields[+(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i))];
    if (!f || !f.entry) return;
    const i = +(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i));
    const open = known ? rows.has(i) : seen === 0;
    box.classList.toggle('wbshut', !open);
    if (open) rows.add(i);
    seen++;
  });
}
// §6.1.3 item 7 — name the field Preview one will use.
//
// The preview selector identifies which field produced the result so users can decide whether to
// commit the pass.
//
// 🔴 THE OPTIONS ARE THE TICKED FIELDS, NOT ALL FIELDS. Previewing an unticked field would show a
// result for something `Run pass` is then going to skip.
/** @param {string} kind */
export function wbSyncPreviewPick(kind) {
  const sel = /** @type {HTMLSelectElement} */ (wbEl(kind, 'wbPreviewPick'));
  if (!sel) return;
  const st = wbState(kind),
    idx = wbTicked(kind);
  /** @type {WbField[]} */
  const fields = st.fields;
  const keep = sel.value;
  sel.innerHTML = idx
    .map(i => {
      const f = fields[i];
      return `<option value="${i}">${esc(f.label)} — ${f.chars} chars</option>`;
    })
    .join('');
  // Hold the previous choice across a re-tick when it is still available; otherwise fall back to
  // the first, which is what the button did before this control existed.
  if (keep && idx.some(i => String(i) === keep)) sel.value = keep;
  sel.disabled = !idx.length;
  /** @type {HTMLButtonElement} */ (wbEl(kind, 'wbPreview')).disabled = !idx.length;
}
/** @param {string} kind */
export function wbPreflight(kind) {
  wbSyncPreviewPick(kind);
  const st = wbState(kind),
    idx = wbTicked(kind);
  /** @type {WbField[]} */
  const fields = st.fields;
  const chars = idx.reduce((a, i) => a + fields[i].chars, 0);
  // 🔴 m4y / §9a.4 — A FILTERED LIST MUST SAY SO, RIGHT HERE.
  //
  // The hazard the design doc names: he filters to Always-injected, presses tick all, runs an
  // instruction across a third of the book and believes it covered all of it. `wbTicked` already
  // makes that arithmetically safe (hidden entries are never in a pass), but safe is not the same
  // as HONEST — "4 of 4 fields selected" over a 12-entry book that is showing 4 is a true sentence
  // that leaves him with a false belief. The denominator stays the whole document and the filter is
  // named, so the two numbers disagreeing is itself the warning.
  const want = /** @type {Record<string, string>} */ (wbModeFilter)[kind] || '';
  // 🔴 §9a.32 — THE DENOMINATOR IS WHAT COULD BE SELECTED, AND AN EMPTY FIELD COULD NOT BE.
  // A sparse card draws a row for every field it does not carry yet, and counting those made the
  // line read "1 of 8 fields selected" over a page with exactly one field a pass can touch. That
  // is the same false-belief failure the filter clause below exists to prevent, from the other
  // direction: seven of those eight are not withheld from the pass, they are EMPTY, and there is
  // no tick he could add to change the number. `.empty` is the SERVER's answer, never a `!chars`
  // here — a field holding whitespace has chars and is still empty to the collector.
  const real = fields.filter(f => !f.empty).length;
  const hidden = real - wbTickable(kind).length;
  const m = want ? ` · showing ${want} entries only — ${hidden} hidden and NOT in this pass` : '';
  /** @type {VEl} */ (wbEl(kind, 'wbPreflight')).textContent = idx.length
    ? `${idx.length} of ${real} field${real === 1 ? '' : 's'} selected · ~${wbMins(wbEstimate(chars, idx.length))}${m}`
    : 'no fields selected' + m;
}
// ── §6.6 find & replace across every field of the open document ─────────────
//
// Find and replace applies across fields in the open character card or worldbook before a pass.
//
// 🔴 HIGHLIGHTING IS THE BROWSER'S JOB, NOT OURS. Every field is a <textarea>, which renders its
// value as plain text — markup inside it is literal, so matched words cannot be painted directly.
// The current match is shown with the browser's own selection (focus + setSelectionRange), which
// is exact, free, and immune to the font-metric drift that a mirrored-overlay approach lives or
// dies by. Each field header carries its own match count, so "17 matches in 5 fields" is
// navigable without coloring all of them at once.
//
// 🔴 LITERAL FIND, LITERAL REPLACE. No regex mode: `{{user}}`, `{{char}}`, `<START>` and `[...]`
// are common literal queries, and a regex mode would make them misfire.
// The result is built by SLICING around match indices — never `String.replace()` with a string
// replacement, which expands `$&` and `$1` and would mangle a literal `$`.
/**
 * @typedef {Object} WbFindState
 * @property {WbFindHit[]} hits
 * @property {number} at - index into `hits` of the current match, or -1.
 */
/**
 * @param {string} kind
 * @returns {WbFindState}
 */
export function wbFindState(kind) {
  const st = wbState(kind);
  return st.find || (st.find = { hits: [], at: -1 });
}
/**
 * @param {string} kind
 * @returns {{q: string, r: string, cs: boolean, word: boolean}}
 */
export function wbFindInputs(kind) {
  return {
    q: /** @type {HTMLInputElement} */ (wbEl(kind, 'wbFindQ')).value,
    r: /** @type {HTMLInputElement} */ (wbEl(kind, 'wbFindR')).value,
    cs: /** @type {HTMLInputElement} */ (wbEl(kind, 'wbFindCase')).checked,
    word: /** @type {HTMLInputElement} */ (wbEl(kind, 'wbFindWord')).checked,
  };
}
// Every match, in document field order — the same order the pass and the preview use, so
// "replace next" goes somewhere he can predict.
//
// 🔴 **A FILTERED-OUT ENTRY IS NOT SEARCHED, AND IT IS THE SAME RULE `wbTicked` ENFORCES.**
// The injection-mode filter (m4y) is a worldbook-only control — a card's own fields have no mode —
// which is why
// this could only ever be seen on a book.
//
// Two failures, and the second is the one that matters:
//   · Ctrl+F3 stepped onto a hit inside a `.wbhide` field. `wbFindGo` unfolds a `.wbfold` row
//     (m4x) but knew nothing about the filter, and `.focus()` on a `display:none` element does
//     nothing at all — so the counter advanced and the screen sat still, which reads as the key
//     being dead rather than as the row being filtered away.
//   · 🔴 **AND REPLACE ALL EDITED THEM.** `f.hits` is what `wbFindReplaceAll` walks, so a
//     replace rewrote entries he had deliberately narrowed off the screen. An edit he cannot see
//     landing in his lorebook is a great deal worse than a navigation glitch.
//
// ⚠️ **FOLDED IS NOT FILTERED, AND THEY RESOLVE OPPOSITE WAYS.** A fold is clutter-hiding on a
// field that is still in scope — m4x's rule is that a hit UNFOLDS it. The filter means "narrow
// this book to one mode", and §9a.4 already settled that hidden-by-filter rows are out of scope:
// `wbTicked` skips them so no pass can include one. Find now agrees with the pass, by
// construction, rather than by two functions happening to make the same choice.
// The entry title's control inside a built ⚙ fold, or null when the fold has never been opened.
/**
 * @param {Element|null} box - the `.wbfield` row, or null when the hit has none (a card field).
 * @returns {Element|null}
 */
export function wbTitleInput(box) {
  return box ? box.querySelector('.wbsf[data-name="comment"] .wbsv') : null;
}
// The entry's title AS IT READS NOW. Prefers the live control — a title he has already retyped
// this session must be searched as it now reads — and falls back to the stored revision, which
// is the only source before the fold has ever been built (m5g builds it lazily).
/**
 * @param {string} kind
 * @param {Element|null} box
 * @param {WbField} fld - must carry `.entry` (only entries have a title/`comment`).
 * @returns {string}
 */
export function wbFindTitleNow(kind, box, fld) {
  const live = wbTitleInput(box);
  if (live) return String(/** @type {HTMLInputElement} */ (live).value || '');
  const entry = /** @type {(string|number)[]} */ (fld.entry);
  const raw = wbRawAt(wbState(kind).rev.content, [...entry, 'comment']);
  return typeof raw === 'string' ? raw : '';
}
// The live element a hit points at, MATERIALIZING it when necessary.
//
// 🔴 A TITLE HIT HAS NO ELEMENT UNTIL THE FOLD IS BUILT, and that is the whole reason this
// exists. The fold is opened HERE — when he steps onto or replaces the hit — and never during
// the scan, which is what keeps "search the titles" from meaning "open 110 settings panes".
//
// Returns an `<input>` for a title and the `<textarea>` for a body. Both carry `.value`,
// `setSelectionRange` and an `input` event, so every caller downstream treats them identically —
// including `wbFindApply`, which is what routes a title edit through `wbSetTouched`/`wbSetDirty`
// and therefore into `wbSetEdits`. A title replace saves by exactly the path a typed one does.
// 🔴 §9a.31 — THE UN-SHUT LIVES HERE, NOT ONLY IN `wbFindGo`. `wbFindGo` clears the accordion
// before it steps onto a hit, but `wbFindReplaceOne` and `wbFindReplaceAll` reach their element
// through THIS function without going through `wbFindGo` first — so a replace would edit the body
// of an entry he cannot see, which is §9a.22 ("FIND SEARCHED ENTRIES HE COULD NOT SEE") with the
// edit already made. One funnel, one place to open the row.
//
// ⚠️ Before the `h.title` early return, deliberately: a BODY hit needs the row opened just as much
// as a title hit does, and it returns `h.ta` without ever looking at `h.box`.
/**
 * @param {string} kind
 * @param {WbFindHit} h
 * @returns {Element|null|undefined}
 */
export function wbFindEl(kind, h) {
  // Through `wbShutToggle`, not `classList.remove`, so `st.openRows` learns about it — otherwise
  // the next render (a Save re-opens the document) would shut the row Find had just opened him
  // into, and he would be looking at a collapsed entry he never closed.
  if (h.box) wbShutToggle(kind, h.box, false);
  if (!h.title) return h.ta;
  if (!h.box) return null;
  // `:not(.wbkeysbody)` for `wbSetToggle`'s reason. `[hidden]` alone happens to exclude the
  // keywords box today because nothing ever hides it — a coincidence, not a rule, and the next
  // person to hide it would silently turn this into "open the fold whenever keywords are hidden".
  if (h.box.querySelector('.wbsetbody:not(.wbkeysbody)[hidden]')) wbSetToggle(kind, h.box);
  return wbTitleInput(h.box);
}
/** @param {string} kind */
export function wbFindScan(kind) {
  const f = wbFindState(kind),
    o = wbFindInputs(kind),
    st = wbState(kind);
  f.hits = [];
  if (!o.q) {
    wbFindPaint(kind);
    return;
  }
  // 📌 Indexed over `.wbfield`, NOT over `.wbtext`, because `fi` is what `wbFindPaint` uses to put
  // a per-field count on a header — skipping rows out of a `.wbtext` list would slide every count
  // onto the wrong entry.
  const boxes = [.../** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbfield')];
  const needle = o.cs ? o.q : o.q.toLowerCase();
  /** @param {string} c */
  const isWordChar = c => /[A-Za-z0-9_]/.test(c || '');
  // One scanner over one string, so a title and a body cannot drift apart about what "whole
  // word" or "match case" mean.
  /**
   * @param {string} hay0
   * @param {{fi: number, box?: Element, ta?: Element, title?: boolean}} where
   */
  const scanInto = (hay0, where) => {
    const hay = o.cs ? hay0 : hay0.toLowerCase();
    let i = 0;
    for (;;) {
      const at = hay.indexOf(needle, i);
      if (at < 0) break;
      const end = at + needle.length;
      // "Whole word" means neither side is glued to a word character. Checked on the ORIGINAL
      // string so the test is about the text, not about the lower-cased copy.
      const ok = !o.word || (!isWordChar(hay0[at - 1]) && !isWordChar(hay0[end]));
      if (ok) f.hits.push({ ...where, start: at, end });
      i = at + Math.max(1, needle.length); // max(1) — an empty needle would spin forever
    }
  };
  boxes.forEach((box, fi) => {
    if (box.classList.contains('wbhide')) return;
    const fld = st.fields[+(/** @type {string} */ (/** @type {HTMLElement} */ (box).dataset.i))];
    // Search the entry title (`comment`) as well as its body. The title is editable in the settings
    // fold, so it is not a `.wbtext` and the body scan does not reach it.
    //
    // ⚠️ ENTRIES ONLY (`fld.entry`). On a character card `label` is the FIELD NAME —
    // "description", "personality" — and matching those would return a hit on every card for
    // the word "description", which is noise, not a search result.
    //
    // 📌 Scanned from the DATA, never from the DOM, because the fold is built lazily (m5g): the
    // input does not exist until the fold has been opened once. `wbFindTitleNow` prefers the
    // live control when there is one so a title edited this session is searched as it now
    // reads, not as it was loaded.
    if (fld && fld.entry) scanInto(wbFindTitleNow(kind, box, fld), { fi, box, title: true });
    const ta = box.querySelector('.wbtext');
    if (ta) scanInto(/** @type {HTMLTextAreaElement} */ (ta).value, { fi, box, ta });
  });
  if (f.at >= f.hits.length) f.at = f.hits.length - 1;
  wbFindPaint(kind);
}
// Per-field counts in the headers, plus the running total. Nothing is colored inside a textarea
// because nothing can be.
/** @param {string} kind */
export function wbFindPaint(kind) {
  const f = wbFindState(kind);
  const boxes = [.../** @type {VEl} */ (wbEl(kind, 'wbFields')).querySelectorAll('.wbfield')];
  /** @type {Record<number, number>} */
  const per = {};
  f.hits.forEach(h => {
    per[h.fi] = (per[h.fi] || 0) + 1;
  });
  boxes.forEach((b, i) => {
    b.classList.remove('wbhit');
    let tag = b.querySelector('.wbcount');
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'small muted wbcount';
      const head = b.querySelector('.wbhead');
      if (head) head.appendChild(tag);
    }
    tag.textContent = per[i] ? ` · ${per[i]} match${per[i] === 1 ? '' : 'es'}` : '';
  });
  const cur = f.hits[f.at];
  if (cur) {
    // ⚠️ `cur.box`, not `cur.ta.closest(...)` — a TITLE hit has no `.ta` at all, and reaching
    // through it threw a TypeError that took the whole find bar down mid-navigation.
    const box = cur.box || (cur.ta && cur.ta.closest('.wbfield'));
    if (box) box.classList.add('wbhit');
  }
  const fields = Object.keys(per).length;
  const el = /** @type {VEl} */ (wbEl(kind, 'wbFindCount'));
  const q = /** @type {HTMLInputElement} */ (wbEl(kind, 'wbFindQ')).value;
  // 🔴 AND IT SAYS WHAT IT DID NOT SEARCH. Same honesty rule the preflight follows: "no matches"
  // over a book that is 90% filtered away is a true sentence and a misleading one, and it sends
  // him looking for a search bug instead of at the dropdown two inches to the left.
  const hidden = boxes.filter(b => b.classList.contains('wbhide')).length;
  const held = hidden ? ` · ${hidden} hidden by the filter and NOT searched` : '';
  // 🔴 "No matches" is SAID. A search that silently does nothing is indistinguishable from a
  // broken one — which is exactly the confusion the failed {{user}} pass caused.
  el.textContent = !q
    ? ''
    : !f.hits.length
      ? 'no matches' + held
      : `${f.at + 1} of ${f.hits.length} · in ${fields} field${fields === 1 ? '' : 's'}${held}`;
  el.style.color = q && !f.hits.length ? 'var(--warn)' : 'var(--muted)';
}
/**
 * @param {string} kind
 * @param {number} step - +1/-1; wraps.
 */
export function wbFindGo(kind, step) {
  const f = wbFindState(kind);
  if (!f.hits.length) {
    wbFindPaint(kind);
    return;
  }
  f.at = (f.at + step + f.hits.length) % f.hits.length; // wraps, deliberately
  const h = f.hits[f.at];
  // A hit inside a collapsed field must unfold it. `wbFindGo` focuses the element and
  // selects the match, and `.focus()` on a
  // `display:none` element silently does nothing. Find would then step through matches while the
  // screen sat still, which reads as find being broken rather than as the field being folded.
  //
  // Clear both the entry accordion and unticked-field fold so every search hit can be seen.
  const hbox = h.box || (h.ta && h.ta.closest('.wbfield'));
  // §9a.31 — the accordion goes through `wbShutToggle` so `st.openRows` records it (a bare
  // `classList.remove` would be undone by the next render). m4x's `.wbfold` is not recorded
  // anywhere and stays a direct class removal.
  if (hbox) {
    hbox.classList.remove('wbfold');
    wbShutToggle(kind, hbox, false);
  }
  // A title hit builds and opens its ⚙ fold here — see `wbFindEl`.
  const el = wbFindEl(kind, h);
  if (!el) {
    wbFindPaint(kind);
    return;
  }
  /** @type {HTMLInputElement|HTMLTextAreaElement} */ (el).focus();
  // `setSelectionRange` isn't in `dom-permissive.d.ts`'s widened `Element` — the caller is always
  // really an `<input>` or `<textarea>` (see `wbFindEl`'s header), so cast rather than widen the
  // shared file for one member.
  try {
    /** @type {HTMLInputElement|HTMLTextAreaElement} */ (el).setSelectionRange(h.start, h.end);
  } catch (e) {
    /* an input type that refuses selection — focus alone still lands him on it */
  }
  // `nearest` rather than `center`: stepping through matches should not yank the page when the
  // next one is already on screen.
  // 🔴 EXCEPT WHEN THE MATCH IS ABOVE THE PINNED CHROME (9.0.8). `nearest` scrolls the minimum to
  // bring the element into the VIEWPORT, and the viewport's top is behind the sticky header and
  // the pinned tab bar — so stepping UP to a match parked it under them, selected and focused and
  // invisible. Stepping through matches goes both ways, so this is the ordinary case, not an edge.
  if (el.getBoundingClientRect().top < stickTop()) scrollUnderStick(el, 10, 'auto');
  else el.scrollIntoView({ block: 'nearest' });
  wbFindPaint(kind);
}
// 🔴 A REPLACE MUST GO THROUGH THE NORMAL DIRTY PATH. Assigning `.value` fires no `input` event,
// so `.wbdirty` never lands and the Save control stays hidden — the edit looks applied and is
// silently unsaveable. Dispatching a real `input` keeps one code path for hand edits and these.
/**
 * @param {Element} ta - the live control (a title `<input>` or a body `<textarea>`).
 * @param {number} start
 * @param {number} end
 * @param {string} text
 */
export function wbFindApply(ta, start, end, text) {
  /** @type {HTMLInputElement|HTMLTextAreaElement} */ (ta).value =
    /** @type {HTMLInputElement|HTMLTextAreaElement} */ (ta).value.slice(0, start) +
    text +
    /** @type {HTMLInputElement|HTMLTextAreaElement} */ (ta).value.slice(end);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
/** @param {string} kind */
export function wbFindReplaceOne(kind) {
  const f = wbFindState(kind),
    o = wbFindInputs(kind);
  const h = f.hits[f.at];
  if (!h) {
    wbFindPaint(kind);
    return;
  }
  // A title hit materializes its control first; `wbFindApply` then dispatches a real `input`,
  // which is what marks the settings row touched+dirty so `wbSetEdits` carries it into the save.
  const el = wbFindEl(kind, h);
  if (!el) {
    wbFindPaint(kind);
    return;
  }
  wbFindApply(el, h.start, h.end, o.r);
  const was = f.at;
  wbFindScan(kind); // indices shift under us; rescan rather than patch
  f.at = Math.min(was, f.hits.length - 1);
  if (f.hits.length) wbFindGo(kind, 0);
  else wbFindPaint(kind);
}
// ⚠️ `async` since m4t: the confirmation is the app's own modal, which is a promise, where the
// native `confirm()` it replaced blocked the thread. The click handler fires and forgets, which
// is right — nothing downstream reads the return.
/** @param {string} kind */
export async function wbFindReplaceAll(kind) {
  const f = wbFindState(kind),
    o = wbFindInputs(kind);
  if (!f.hits.length) {
    wbFindPaint(kind);
    return;
  }
  const fields = new Set(f.hits.map(h => h.fi)).size;
  if (
    !(await wbConfirm(
      'Replace all?',
      `<p>Replace <b>${f.hits.length}</b> match${f.hits.length === 1 ? '' : 'es'} in ` +
        `<b>${fields}</b> field${fields === 1 ? '' : 's'}?</p>` +
        '<p class="small muted">Nothing is written until you press Save, so Close without saving ' +
        'undoes it.</p>',
      'Replace all',
    ))
  )
    return;
  // Per field, right to left: every replacement shifts the offsets after it, and walking
  // backward means the indices already collected stay correct.
  // ⚠️ Grouped by the LIVE ELEMENT, resolved once per hit — a title hit has no element until
  // `wbFindEl` builds its fold, and resolving inside the loop is what makes "replace all" reach
  // titles at all. A hit whose element cannot be resolved is skipped rather than silently
  // counted as replaced.
  /** @type {Map<Element, WbFindHit[]>} */
  const byField = new Map();
  f.hits.forEach(h => {
    const el = wbFindEl(kind, h);
    if (!el) return;
    if (!byField.has(el)) byField.set(el, []);
    /** @type {WbFindHit[]} */ (byField.get(el)).push(h);
  });
  byField.forEach((hits, el) => {
    let v = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (el).value;
    hits
      .slice()
      .sort((a, b) => b.start - a.start)
      .forEach(h => {
        v = v.slice(0, h.start) + o.r + v.slice(h.end);
      });
    /** @type {HTMLInputElement|HTMLTextAreaElement} */ (el).value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  wbFindScan(kind);
}
/** @param {string} kind */
export function wbFindOpen(kind) {
  const bar = /** @type {VEl} */ (wbEl(kind, 'wbFind'));
  bar.style.display = 'flex';
  /** @type {VEl} */ (wbEl(kind, 'wbFindQ')).focus();
  /** @type {HTMLInputElement} */ (wbEl(kind, 'wbFindQ')).select();
  wbFindScan(kind);
}
/** @param {string} kind */
export function wbFindClose(kind) {
  const f = wbFindState(kind);
  f.hits = [];
  f.at = -1;
  /** @type {VEl} */ (wbEl(kind, 'wbFind')).style.display = 'none';
  wbFindPaint(kind);
}

// Keep the Ctrl+F3 listener beside `wbFindGo`, the only function it calls.
//
// ⚠️ A top-level statement in a module is SAFE here for the reason `say.js` records: it registers
// after parsing and still catches every later key. It is deliberately outside every range the
// smoke specs slice — `grab()` compiles a function's own source and stops at its closing brace, so
// a listener sitting between functions is never run in their stub sandbox, which has no `document`.

// Bind Ctrl+F3 on the document because `wbFindGo` moves focus into the matched field; a
// search-box Enter handler would miss subsequent key presses. Preserve browser F3 and Ctrl+F.
//
// ⚠️ Which pane? The one whose find bar is open. Only one editor is open at a time, so this
// cannot be ambiguous, and if none is open the key is left to the browser untouched.
document.addEventListener('keydown', e => {
  if (e.key !== 'F3' || !e.ctrlKey || e.altKey || e.metaKey) return;
  for (const kind of Object.keys(WB_KIND)) {
    const bar = /** @type {VEl} */ (wbEl(kind, 'wbFind'));
    if (!bar || bar.style.display === 'none') continue;
    e.preventDefault();
    wbFindGo(kind, e.shiftKey ? -1 : 1);
    return;
  }
});
