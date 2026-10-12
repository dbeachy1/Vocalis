// Coverage for the Import & merge dialog initial radio selections.
// The selected choice is submitted directly by choices(), so the default determines the
// merge result. Route tests cover how supplied choices are applied; this harness checks
// what the dialog renders and submits.

// The harness renders and calls the real functions rather than grepping source. Source-string
// checks can match comments or docstrings and pass even when executable behavior is wrong.
// The sliced helpers need only small fakes for esc, wbDiff, and document.addEventListener.

// Usage: node wbedit_merge_dialog_smoke.mjs <path-to-index.html>
// Exit 0 means all checks passed.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node wbedit_merge_dialog_smoke.mjs <index.html>');
  process.exit(2);
}

let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

// Normalized to LF — this file is checked out with CRLF, and a CRLF haystack silently zeroes out
// every newline-anchored regex below. See the note in voices_ui_smoke.mjs.
const mergePath = join(dirname(htmlPath), 'js', 'wb', 'merge.js');
const main = (await readFile(mergePath, 'utf8')).replace(/\r\n/g, '\n').replace(/^export /gm, '');
ok(/^function fieldPicker\(name, f\) \{/m.test(main), `read the merge dialog module at ${mergePath}`);

// ── slice the render helpers out of the real file ────────────────────────────
// `function pane` through `function choices` is pane · lines · side · asText · mineSide · editable
// · picker · fieldPicker · the delegated change listener · body. `choices()` itself is left out
// deliberately: it walks a live `#mBody`, which is the one thing here that needs a real browser.
const from = main.search(/^function pane\(/m);
const to = main.search(/^function choices\(/m);
ok(from > 0 && to > from, 'located pane…body in the real file');
if (!(from > 0 && to > from)) process.exit(1);

const sandbox = {
  esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  // The pass pane's word diff. Only `.after` is read here, and only for the text in it.
  wbDiff: (a, b) => ({ before: a, after: b }),
  document: { addEventListener: () => {}, querySelector: () => null },
};
vm.createContext(sandbox);
vm.runInContext(main.slice(from, to), sandbox);

// One checked radio per `name`, as `{name: value}` — which is the shape `choices()` reads back out
// of the dialog, so this is what the route would actually receive.
const checked = markup => {
  const out = {};
  for (const m of markup.matchAll(/<input type="radio"[^>]*name="([^"]+)" value="([^"]+)" checked>/g)) out[m[1]] = m[2];
  return out;
};
const offered = markup => [...markup.matchAll(/<input type="radio"[^>]*name="([^"]+)" value="([^"]+)"/g)].map(m => m[1] + '=' + m[2]);

// ── 1. a text conflict pre-selects the FILE ──────────────────────────────────
const textField = {
  name: 'content',
  path: ['content'],
  verdict: 'conflict',
  base: 'the original line',
  mine: 'the line after my edit',
  theirs: 'the line the update brings',
};
const one = sandbox.fieldPicker('0:content', textField);
ok(checked(one)['0:content'] === 'theirs', `a text conflict starts on the imported file (got ${checked(one)['0:content']})`);
ok(Object.keys(checked(one)).length === 1, 'exactly one answer is pre-selected');
// 🔴 AND ALL THREE ANSWERS ARE STILL THERE. A default flip that quietly dropped one would satisfy
// the check above while preserving the requested answer.
ok(
  offered(one).join(',') === '0:content=mine,0:content=theirs,0:content=edited',
  `all three answers are offered, in pane order (${offered(one).join(',')})`,
);
// ⚠️ The hand-edit box still starts from the FILE's text — the pairing this default was chosen with.
ok(/<textarea class="mergeEdit"[^>]*>the line the update brings<\/textarea>/.test(one), 'the hand-edit box is seeded from the file');

// ── 2. a NON-TEXT conflict pre-selects the file too ──────────────────────────
// `editable()` sends numbers, booleans and keyword lists down a different return, and that return
// carried its own separate default.
const numField = { name: 'order', path: ['order'], verdict: 'conflict', base: 1, mine: 5, theirs: 9 };
const two = sandbox.fieldPicker('0:order', numField);
ok(checked(two)['0:order'] === 'theirs', `a numeric conflict starts on the imported file (got ${checked(two)['0:order']})`);
ok(!/mergeEdit/.test(two), 'a numeric conflict gets no free-text box');

// ── 3. the whole dialog body: both conflict kinds and a deletion ─────────────
const preview = {
  name: 'Test World Book 2',
  base: 4,
  revision: 7,
  tally: { changed: 2, added: 1 },
  entries: [
    {
      label: 'Ashfall',
      status: 'changed',
      fields: [textField, { name: 'key', path: ['key'], verdict: 'take_theirs', mine: ['a'], theirs: ['b'] }],
    },
    { label: 'Kestrel', status: 'removed_edited', fields: [] },
  ],
  doc_fields: [{ name: 'description', path: ['description'], verdict: 'conflict', base: 'was', mine: 'mine', theirs: 'theirs' }],
};
const markup = sandbox.body(preview);
const picks = checked(markup);
ok(picks['0:content'] === 'theirs', `an entry conflict in the real body starts on the file (got ${picks['0:content']})`);
ok(picks['doc:description'] === 'theirs', `a document-level conflict starts on the file (got ${picks['doc:description']})`);
// 🔴 A DELETION IS THE OPPOSITE ANSWER, ON PURPOSE. The file wins where the file carries text that
// is stored nowhere else; a deletion carries no text, so pre-selecting it would bin an entry he
// edited deliberately and gain nothing recoverable in exchange. Both halves are pinned here, or
// "make these two consistent" is a one-line change nobody would think to question.
ok(picks['entry:1'] === 'keep', `a deletion he has edited starts on KEEP, not drop (got ${picks['entry:1']})`);
ok(Object.keys(picks).length === 3, `three decisions, three pre-selected answers (${Object.keys(picks).join(', ')})`);
// A field the engine already resolved is not a decision and gets no radio at all.
ok(!/name="0:key"/.test(markup), 'a field the merge resolved on its own is not put to him');
ok(/3 things need you/.test(markup), 'the heading counts the rows it drew');

process.exit(failed ? 1 : 0);
