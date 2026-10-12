// ── ⇄ Import & merge — 9.6 ───────────────────────────────────────────────────────────────────
//
// Import can either create a document or merge a source update into an existing document while
// preserving local edits.
//
// 🔴 **TWO ROUND TRIPS, AND THE FIRST ONE WRITES NOTHING.** `POST …/merge` previews by default and
// mints only on `apply=1`, so this uploads the file, shows what would happen, and uploads it a
// second time with his answers. Holding the parsed document in the browser between the two would
// make this module the authority on what a worldbook is — the same reason ⬆ Import entry sends the
// bytes rather than parsing them here.
//
// 🔴 **AND THE SECOND POST CARRIES THE REVISION THE FIRST ONE REPORTED.** Every choice below
// addresses an entry by its INDEX in the merge result, which only means anything against the three
// documents the preview was computed from. If the head moved while the dialog was open — another
// tab, an ST push, a pass applied — those indices address different entries, and the route answers
// 409 rather than writing them. The dialog is a file picker plus a modal, so that window is not a
// click; it is however long he spends reading.
import { modal } from '../ui/modal.js';
import { esc } from '../util/dom.js';
import { wbDocKind } from './kind.js';
import { wbOpen } from './open.js';
import { wbDiff } from './pass.js';
import { wbSay } from './say.js';
import { wbGen, wbStale, wbState } from './state.js';

/** Render one conflict side without truncating its text. Use a `<div>` so diff highlights remain visible and selectable.
 * @param {string} title
 * @param {string} html - already escaped, and may carry `<ins>`/`<del>`.
 * @returns {string}
 */
function pane(title, html) {
  return '<div class="mergeSide"><b>' + esc(title) + '</b><div class="mergeText">' + html + '</div></div>';
}

/**
 * How many lines a string occupies. Used to size a box to its content before the CSS caps it.
 *
 * @param {string} text
 * @returns {number}
 */
function lines(text) {
  return text.split('\n').length;
}

/**
 * The plain side: no diff, just the text.
 *
 * @param {string} title
 * @param {unknown} value
 * @returns {string}
 */
function side(title, value) {
  return pane(title, esc(asText(value)));
}

/**
 * A field value as the text a human reads.
 *
 * ⚠️ `undefined` is the field being ABSENT on that side, which is a fact worth saying out loud —
 * an empty box reads as "he deleted the text", and those are different answers to "what happened
 * here". A non-string is pretty-printed rather than `String()`-ed, because `[object Object]` in a
 * conflict pane is a dialog that has stopped explaining itself.
 *
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  if (value === undefined) return '(the field is not there on this side)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/** Render the local side with changes from the shared base highlighted. Reuse `wbDiff` so the merge and proposal panes use the same word-diff implementation. Fall back to plain text when either value is not a string.
 * @param {any} f - one field of the merge result.
 * @returns {string}
 */
function mineSide(f) {
  if (typeof f.mine !== 'string' || (f.base !== undefined && typeof f.base !== 'string')) return side('Yours', f.mine);
  // A zero-width space for `wbRepaintDiff`'s reason: a trailing newline inside a block collapses,
  // and the last line of his edit would sit half a line higher than the rest.
  return pane('Yours — green is what you changed', wbDiff(typeof f.base === 'string' ? f.base : '', f.mine).after + '​');
}

/** Allow free-text resolution only when both conflict values are strings.
 * @param {any} f - one field of the merge result.
 * @returns {boolean}
 */
function editable(f) {
  const sides = [f.mine, f.theirs].filter(v => v !== undefined);
  return sides.length > 0 && sides.every(v => typeof v === 'string');
}

/**
 * A radio pair. `name` is the address the route reads back, so it is also the DOM name.
 *
 * @param {string} name
 * @param {string} checked
 * @param {[string, string][]} options - `[value, label]`.
 * @returns {string}
 */
function picker(name, checked, options) {
  return (
    '<div class="mergePick">' +
    options
      .map(
        ([value, label]) =>
          '<label><input type="radio" data-merge-pick="' +
          esc(name) +
          '" name="' +
          esc(name) +
          '" value="' +
          esc(value) +
          '"' +
          (value === checked ? ' checked' : '') +
          '> ' +
          esc(label) +
          '</label>',
      )
      .join('') +
    '</div>'
  );
}

/** Render conflict choices and the editable result. Default to the imported value because the local value remains in revision history while the incoming file is otherwise uncaptured. Seed the edit box from the imported value; keep the choice controls aligned with their panes.
 * @param {string} name
 * @param {any} f
 * @returns {string}
 */
function fieldPicker(name, f) {
  /** @type {[string, string][]} */
  const options = [
    ['mine', 'Keep mine'],
    ['theirs', 'Take the file'],
  ];
  if (!editable(f)) return picker(name, 'theirs', options);
  options.push(['edited', 'Let me write it']);
  const seed = typeof f.theirs === 'string' ? f.theirs : '';
  return (
    picker(name, 'theirs', options) +
    '<textarea class="mergeEdit" data-edit-for="' +
    esc(name) +
    '" rows="' +
    Math.min(20, Math.max(6, lines(seed) + 2)) +
    '">' +
    esc(seed) +
    '</textarea>'
  );
}

// 🔴 DELEGATED, AND REGISTERED ONCE AT MODULE LOAD. `modal()` replaces `#mBody`'s innerHTML on every
// call, so a listener bound to a control inside it dies with the dialog that created it — and the
// SECOND merge of a session would have a third radio button that does nothing. Bound to `document`,
// this cannot be thrown away by an innerHTML swap.
document.addEventListener('change', e => {
  const el = /** @type {HTMLInputElement} */ (e.target);
  if (!el || el.tagName !== 'INPUT' || el.type !== 'radio' || !el.dataset.mergePick) return;
  const box = document.querySelector('#mBody textarea[data-edit-for="' + el.dataset.mergePick.replace(/"/g, '') + '"]');
  // `.on` rather than `hidden`: a class this stylesheet owns cannot be beaten by a `display` rule
  // somebody adds to `.mergeEdit` later, and the reveal silently failing is hard to notice.
  if (box) box.classList.toggle('on', el.value === 'edited');
});

/**
 * The dialog body: what will happen, then everything that needs him.
 *
 * 🔴 **THE DECISIONS COME FIRST AND THE SUMMARY IS ONE LINE.** A pane that lists all forty
 * resolved entries above the two conflicts is a pane he scrolls past, and the whole value of the
 * feature is that the number of things he has to read is small. The counts say what was settled
 * without him; the blocks below are the remainder.
 *
 * @param {any} j - the preview body.
 * @returns {string}
 */
function body(j) {
  const t = j.tally || {};
  const df = j.doc_fields || [];
  const count = (/** @type {string} */ v) => df.filter((/** @type {any} */ f) => f.verdict === v).length;
  const bits = [];
  if (t.changed) bits.push(t.changed + ' entr' + (t.changed === 1 ? 'y' : 'ies') + ' updated');
  if (t.added) bits.push(t.added + ' added');
  if (t.removed) bits.push(t.removed + ' omitted from the file, kept');
  if (t.mine_only) bits.push(t.mine_only + ' of yours untouched');
  if (t.removed_updated) bits.push(t.removed_updated + ' you deleted, left deleted');
  if (t.same) bits.push(t.same + ' unchanged');
  // 🔴 **THE FIELDS COUNT TOO.** The tally above is entries only; a card with
  // no embedded lorebook has none, so every count was zero and the sentence below fired over a
  // conflict the same dialog was already showing. A book keeps almost everything inside an
  // entry and a card keeps almost nothing there — a summary that reads only one of the two is
  // wrong for whichever kind it is not looking at.
  const taken = count('theirs') + count('agreed');
  const kept = count('mine');
  const conflicted = count('conflict');
  if (taken) bits.push(taken + ' field' + (taken === 1 ? '' : 's') + ' updated');
  if (kept) bits.push(kept + ' of your field edits kept');
  if (conflicted) bits.push(conflicted + ' field' + (conflicted === 1 ? '' : 's') + ' to decide');

  let html =
    '<p>Merging into <b>' +
    esc(j.name || 'this document') +
    '</b>, comparing against revision ' +
    j.base +
    '.</p><p class="muted">' +
    (bits.length ? esc(bits.join(', ')) + '.' : 'Nothing in this file differs from what you have.') +
    '</p>';

  // ⚠️ SAID PLAINLY, BECAUSE IT CHANGES HOW MUCH TO TRUST THE PAIRING BELOW. A regenerated file
  // has fresh uids, so entries were matched by title — which is weaker, and is the difference
  // between "this is the same entry" and "these have the same name".
  if (j.renumbered)
    html +=
      '<p class="warn">This file looks rebuilt rather than edited — its entry ids do not line up ' +
      'with yours, so entries were matched by title. Check the pairings below before applying.</p>';

  // ⚠️ A CARD'S FIELDS ARE `doc_fields`, NOT `entries`, so the conflict sweep below has to walk
  // both. A book puts everything interesting inside an entry and its `doc_fields` are the book's
  // name; a card is the other way round, and a version of this that only read `entries` showed a
  // card merge as "nothing needs a decision" over two conflicting descriptions.

  /** @type {string[]} */ const rows = [];
  (j.entries || []).forEach((/** @type {any} */ e, /** @type {number} */ i) => {
    if (e.status === 'removed_edited') {
      // 🔴 **A DELETION KEEPS ITS "KEEP MINE" DEFAULT, AND THAT DOES NOT CONTRADICT `fieldPicker`.**
      // The rule up there is that the file wins because the file's text is the only side that is
      // saved nowhere else. A deletion carries no text: answering "keep" loses nothing the file was
      // bringing, and re-doing the deletion later is one click in the editor — whereas answering
      // "drop" by default would quietly bin an entry he edited on purpose. Same asymmetry, opposite
      // answer: pre-select whichever side is not the destructive one.
      rows.push(
        '<div class="mergeRow"><b>' +
          esc(e.label) +
          '</b> — the file deletes this entry, and you have edited it since the last import.' +
          picker('entry:' + i, 'keep', [
            ['keep', 'Keep my version'],
            ['drop', 'Let the file delete it'],
          ]) +
          '</div>',
      );
      return;
    }
    (e.fields || []).forEach((/** @type {any} */ f) => {
      if (f.verdict !== 'conflict') return;
      rows.push(
        '<div class="mergeRow"><b>' +
          esc(e.label) +
          '</b> · ' +
          esc(f.name) +
          mineSide(f) +
          side('The file', f.theirs) +
          fieldPicker(i + ':' + f.name, f) +
          '</div>',
      );
    });
  });

  (j.doc_fields || []).forEach((/** @type {any} */ f) => {
    if (f.verdict !== 'conflict') return;
    rows.push(
      '<div class="mergeRow"><b>' +
        esc(f.name) +
        '</b>' +
        mineSide(f) +
        side('The file', f.theirs) +
        fieldPicker('doc:' + f.name, f) +
        '</div>',
    );
  });

  html += rows.length
    ? '<h4>' + rows.length + (rows.length === 1 ? ' thing needs you' : ' things need you') + '</h4>' + rows.join('')
    : '<p class="ok">Nothing here needs a decision.</p>';
  return html;
}

/**
 * Read the radios back out of the dialog. Returns the two maps the route expects.
 *
 * ⚠️ **READ AFTER `modal()` RESOLVES, WHICH IS SAFE AND IS NOT AN ACCIDENT.** `done()` removes the
 * overlay's `on` class and leaves `#mBody` exactly as it was; the markup is replaced only by the
 * NEXT `modal()` call, and nothing runs between the promise resolving and this line.
 *
 * @returns {{fields: Record<string,string>, entries: Record<string,string>, edits: Record<string,string>}}
 */
function choices() {
  /** @type {Record<string,string>} */ const fields = {};
  /** @type {Record<string,string>} */ const entries = {};
  /** @type {Record<string,string>} */ const edits = {};
  document.querySelectorAll('#mBody input[type=radio]:checked').forEach(el => {
    const name = /** @type {HTMLInputElement} */ (el).name;
    const value = /** @type {HTMLInputElement} */ (el).value;
    if (name.startsWith('entry:')) {
      entries[name.slice(6)] = value;
      return;
    }
    fields[name] = value;
    if (value !== 'edited') return;
    // ⚠️ ONLY FOR THE ANSWER THAT IS SELECTED. Sending every box would ship the seed text of every
    // conflict he looked at and moved on from, and the route would then have to decide which of
    // them meant anything — a decision that belongs to the radio he can see.
    const box = document.querySelector('#mBody textarea[data-edit-for="' + name.replace(/"/g, '') + '"]');
    if (box) edits[name] = /** @type {HTMLTextAreaElement} */ (box).value;
  });
  return { fields, entries, edits };
}

/**
 * @param {string} kind
 * @param {File} file
 */
export async function wbMergeImport(kind, file) {
  const st = wbState(kind);
  const noun = wbDocKind(kind) === 'card' ? 'character card' : 'World Book';
  if (!st.doc) {
    wbSay(kind, 'Open a ' + noun + ' first.', true);
    return;
  }
  // Pinned before the upload, for ⬆ Import entry's reason: this ends in a WRITE, the roster stays
  // clickable while the file goes up and while the dialog is open, and a merge must not land on
  // whatever document happens to be open when he presses Apply.
  const seq = wbGen(kind);
  const docId = st.doc.id;
  const url = '/wbedit/documents/' + encodeURIComponent(docId) + '/merge';

  wbSay(kind, 'comparing ' + file.name + '…', 'busy');
  const preview = await post(kind, url, file);
  if (!preview) return;
  if (wbStale(kind, seq)) return; // he moved on while it uploaded

  const answer = await modal(
    'Import & merge — ' + (preview.name || ''),
    body(preview),
    [
      { label: 'Cancel', value: false },
      { label: 'Apply', class: 'primary', value: true },
    ],
    // Two full versions of a worldbook entry side by side do not fit a 520px column, and an
    // untruncated pane can be taller than the screen — which would push Apply off the bottom.
    { wide: true, tall: true },
  );
  if (!answer) {
    wbSay(kind, 'nothing was merged.', '');
    return;
  }
  const picked = choices();

  wbSay(kind, 'merging…', 'busy');
  const done = await post(kind, url, file, {
    apply: '1',
    // 🔴 THE REVISION THE PREVIEW WAS COMPUTED AGAINST, NEVER THE ONE THAT IS LATEST NOW. Sending
    // "latest" would make the guard agree with itself and apply choices to a document nobody
    // reviewed. See the route's own note.
    revision: String(preview.revision),
    field_choices: JSON.stringify(picked.fields),
    entry_choices: JSON.stringify(picked.entries),
    field_edits: JSON.stringify(picked.edits),
  });
  if (!done) return;
  if (wbStale(kind, seq)) return;

  await wbOpen(kind, docId, done.revision);
  const t = done.tally || {};
  wbSay(
    kind,
    'merged as revision ' +
      done.revision +
      ' — ' +
      (t.changed || 0) +
      ' updated, ' +
      (t.added || 0) +
      ' added, ' +
      done.conflicts +
      ' decided by you. The version you had is still in the revision picker.',
    'ok',
  );
}

/**
 * One POST to the merge door, with the message for every way it can say no.
 *
 * @param {string} kind
 * @param {string} url
 * @param {File} file
 * @param {Record<string,string>} [form]
 * @returns {Promise<any|null>} the body, or null when it has already been reported.
 */
async function post(kind, url, file, form) {
  const fd = new FormData();
  fd.append('file', file);
  if (form) Object.keys(form).forEach(k => fd.append(k, form[k]));
  let r, j;
  try {
    // ⚠️ Raw `fetch`, not `jpost`: this is multipart, and `jpost` sets a JSON content type — the
    // same reason `wbImport` and `wbImportEntry` do it by hand.
    r = await fetch(url, { method: 'POST', body: fd });
    j = await r.json().catch(() => ({}));
  } catch (e) {
    wbSay(kind, 'could not reach the server.', 'bad');
    return null;
  }
  if (r.ok) return j;
  wbSay(
    kind,
    r.status === 423
      ? 'Vocalis is locked — log in first.'
      : r.status === 409
        ? // The one refusal with an instruction in it: his answers were about a version that is no
          // longer current, and re-reading is the only honest way forward.
          'this book moved to revision ' +
          (j.latest ?? '?') +
          ' while the dialog was open — nothing was merged. Try again to compare against the new version.'
        : j.error || 'the merge failed (HTTP ' + r.status + ')',
    true,
  );
  return null;
}
