// Vocalis 4.5 — the Bulk tab's STAGED FILE LIST (§5a), driven by tests/test_bulk_ui.py.
//
// The list is the feature: files upload as they're picked and the folder is read back on load,
// The staged list must render files persisted by upload, remove the selected file, and
// escape filenames before inserting them into the page.
// No npm dependencies (the st_player_smoke.mjs / stems_widget_smoke.mjs convention): the
// helpers touch only $(), so tiny fake elements are enough.
//
// Usage: node bulk_staged_smoke.mjs <path-to-index.html>
// Exit 0 = all checks passed.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { readPage, textRe } from './_websrc.mjs';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node bulk_staged_smoke.mjs <index.html>');
  process.exit(2);
}

// Normalized to LF — see the note in voices_ui_smoke.mjs. A CRLF checkout silently zeroes
// out newline-anchored regexes.
// The page AS SERVED: index.html with its stylesheets inlined. Every CSS assertion
// below depends on that - those rules left this file for src/webui/css/ at 7.3.19.
const html = await readPage(htmlPath);
let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

// 🔴 7.3-m4h: THE WHOLE BULK TAB IS js/media/bulk.js NOW, so `main` IS that module — not the
// page's inline block, and not the two joined together either. Every needle this file uses names a
// `blk*` definition, and all 28 of them moved as one piece, so there is nothing left in the page to
// search and joining the halves would only create a way to slice across the seam.
//
// ⚠️ WHICH IS WHY THE TWO STREAM SLICES CHANGED THEIR END MARKER. They ran to
// `// ── Voice Training`, the banner that followed Bulk in the page — and that banner STAYED
// there. Against the joined halves `blkCloseStream` would then sit AFTER its own end marker, and
// `String.slice(bigger, smaller)` answers '' without complaining: every check below it would fail,
// describing the stream handler, about a file that is perfectly fine. Both now run to the END of
// the module, which is the same span (blkHandleEvent is its last definition) and cannot straddle.
//
// 🔴 `export ` IS STRIPPED because these slices run under `vm.runInContext`, which compiles a
// CLASSIC script: one leaked keyword is `SyntaxError: Unexpected token 'export'` and every check
// after it silently never runs. Only `loadBulk` carries one, and it is inside the second slice.
const bulkPath = join(dirname(htmlPath), 'js', 'media', 'bulk.js');
const main = (await readFile(bulkPath, 'utf8')).replace(/\r\n/g, '\n').replace(/^export /gm, '');
// 🔴 RESPACED, NOT MOVED. This read `/^const blk=\{jobId:null/m` and went red in 8.3.2, when
// Prettier put `jobId: null` on a line of its own. Still anchored to column 0 — load-bearing here,
// because this harness reads the module RAW, comments and all, and the block above the declaration
// names `blk` repeatedly — and still the `blk` object literal whose first key is `jobId: null`.
// Only the whitespace it tolerates changed. NOT widened to get green.
ok(/^const blk\s*=\s*\{\s*jobId:\s*null/m.test(main), `read the Bulk module at ${bulkPath}`);

// ── slice the staged-list helpers out of the real file ───────────────────────
// 🔴 THE START MARKER IS A REGEX NOW, NOT AN `indexOf` STRING, for the same reason. The dense
// `function blkReady(){const n=` is nowhere in the respaced file, `indexOf` answers -1, and a -1
// slice is `''` — so every staged-list check below would have failed, describing render helpers
// that never changed. `textRe` names the SAME tokens with the whitespace between them made
// elastic, so this is still blkReady's DEFINITION followed by its own first statement: it cannot
// drift onto another function, and `const n` keeps its mandatory space so it cannot fuse either.
const fromM = textRe('function blkReady(){const n=').exec(main);
const from = fromM ? fromM.index : -1;
const to = main.indexOf('async function blkLoadStaged(');
ok(from > 0 && to > from, 'located blkReady + blkRenderStaged in the real file');
if (!(from > 0 && to > from)) process.exit(1);

const els = {};
const mkEl = () => ({ innerHTML: '', textContent: '', disabled: false, onclick: null, style: {} });
const sandbox = {
  esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  fmtSize: b => (b == null ? '' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB'),
  $: id => (els[id] ||= mkEl()),
  document: { querySelectorAll: () => [] },
  blk: { staged: [], staging: false },
  // §5b: per-mode workspaces. blkW() is the active one; the helpers read through it.
  BLKW: {
    enhance: { staged: [], view: 'setup', log: '', manifest: null, start: 0 },
    cleanup: { staged: [], view: 'setup', log: '', manifest: null, start: 0 },
  },
  blkMode: 'enhance',
  blkModeAvail: () => true,
  blkStageRemove: () => {},
  blkStageClear: () => {},
};
sandbox.blkW = () => sandbox.BLKW[sandbox.blkMode];
vm.createContext(sandbox);
vm.runInContext(main.slice(from, to), sandbox);

// ── 1. nothing staged → no list, ▶ disabled ──────────────────────────────────
sandbox.BLKW.enhance.staged = [];
sandbox.blkRenderStaged();
ok(els.blkStaged.innerHTML === '', 'an empty staging area draws no list');
ok(els.blkGo.disabled === true, 'nothing staged → the run button is disabled');

// ── 2. rows render: name, size, a ✕ each, and one Remove all ─────────────────
sandbox.BLKW.enhance.staged = [
  { name: 'chapter01.mp3', size: 4_200_000, mtime: 1 },
  { name: 'chapter02.wav', size: 3_800_000, mtime: 2 },
];
sandbox.blkRenderStaged();
const h = els.blkStaged.innerHTML;
ok(h.includes('chapter01.mp3') && h.includes('chapter02.wav'), 'every staged filename is shown');
ok((h.match(/class="blkx"/g) || []).length === 2, 'one ✕ per row');
ok((h.match(/Remove all/g) || []).length === 1, 'exactly one Remove all button');
ok(h.includes('4.2 MB') && h.includes('3.8 MB'), 'each row shows its size');
ok(h.includes('8.0 MB'), 'the footer totals the batch size');
ok(h.includes('2 files'), 'the footer counts the files');
ok(els.blkGo.disabled === false, 'files staged → the run button is live');
ok(els.blkPick.innerHTML.includes('2 files staged'), 'the picker note reports the STAGED count');
// The browser's own "No file chosen" is hidden (#blkFiles{color:transparent}) because the input is
// cleared after every pick, so it always read wrong. #blkChosen stands in and counts what's STAGED.
ok(
  els.blkChosen.textContent === '2 files chosen',
  `the Choose Files label reports the staged count, not the cleared input ("${els.blkChosen.textContent}")`,
);

// ── 3. the ✕ addresses the file BY NAME ──────────────────────────────────────
ok(
  h.includes('data-name="chapter01.mp3"') && h.includes('data-name="chapter02.wav"'),
  'each ✕ carries its own filename, so it removes the row it sits on',
);

// ── 4. a filename is DATA, never markup ──────────────────────────────────────
// Filenames come off the user's disk and go straight into innerHTML. The staging area is the
// one place in Bulk where an attacker-chosen string is rendered, so escaping is load-bearing.
sandbox.BLKW.enhance.staged = [{ name: '<img src=x onerror=alert(1)>.mp3', size: 10, mtime: 1 }];
sandbox.blkRenderStaged();
const x = els.blkStaged.innerHTML;
ok(!x.includes('<img src=x'), 'a filename with markup in it is escaped, not injected');
ok(x.includes('&lt;img'), 'the escaped filename is still shown to the user');

// ── 5. an upload in flight keeps ▶ disabled ──────────────────────────────────
// Otherwise you could start a batch against a half-staged folder and silently process a subset.
sandbox.BLKW.enhance.staged = [{ name: 'a.mp3', size: 10, mtime: 1 }];
sandbox.blk.staging = true;
sandbox.blkReady();
ok(els.blkGo.disabled === true, 'a run cannot start while an upload is still in flight');
sandbox.blk.staging = false;
sandbox.blkReady();
ok(els.blkGo.disabled === false, 'and it goes live again once the upload lands');

// ── 6. §5b: the two tabs read their OWN list ─────────────────────────────────
// The render must go through blkW() — the ACTIVE mode's bucket — not a single global list.
sandbox.BLKW.enhance.staged = [{ name: 'enhance-only.mp3', size: 10, mtime: 1 }];
sandbox.BLKW.cleanup.staged = [{ name: 'cleanup-only.mp3', size: 20, mtime: 1 }];
sandbox.blk.staging = false;

sandbox.blkMode = 'enhance';
sandbox.blkRenderStaged();
const eh = els.blkStaged.innerHTML;
ok(eh.includes('enhance-only.mp3') && !eh.includes('cleanup-only.mp3'), 'the Enhance tab lists ONLY its own staged files');

sandbox.blkMode = 'cleanup';
sandbox.blkRenderStaged();
const ch = els.blkStaged.innerHTML;
ok(ch.includes('cleanup-only.mp3') && !ch.includes('enhance-only.mp3'), 'the Clean up tab lists ONLY its own staged files');

// and an empty tab stays empty even when the other has files staged
sandbox.BLKW.cleanup.staged = [];
sandbox.blkRenderStaged();
ok(els.blkStaged.innerHTML === '', 'an empty tab draws nothing while the other still has files');
ok(els.blkGo.disabled === true, 'and its run button is disabled, not armed by the other tab');

// ── 7. §5c: the tabs read in pipeline order and default to step 1 ────────────
// clean → enhance is one-way (4.4 §6), so the tabs go left-to-right in that order and a fresh
// browser starts on Clean up. These are markup/state facts the render helpers can't show, so
// they're checked against the file itself.
const tabs = html.match(/<div class="tabs" id="blkModeTabs"[\s\S]*?<\/div>/);
ok(!!tabs, 'found the Bulk mode tabs');
if (tabs) {
  const order = [...tabs[0].matchAll(/data-blkmode="(\w+)"/g)].map(m => m[1]);
  ok(order[0] === 'cleanup' && order[1] === 'enhance', `tabs read in pipeline order: ${order.join(' → ')}`);
  const active = tabs[0].match(/data-blkmode="(\w+)" class="active"/);
  ok(active && active[1] === 'cleanup', 'Clean up is the tab marked active in the markup');
}
// 🔴 ANCHORED ON THE DECLARATION, NOT ON THE COMMA. This read
// `/let blkStart=0,blkMode='cleanup';/` and went red in 8.3 when `blkMode` was given a
// `/** @type {BlkMode} */`, because JSDoc can only annotate a SINGLE-declarator statement, so the
// pair had to be split into two lines. Nothing about the claim changed — `blkMode` still
// initializes to 'cleanup' — and `blkStart` was never part of what this check is about; it was
// only ever in the pattern because it happened to share the line.
// ⚠️ NOT A WIDENING TO GET GREEN. It is still pinned to a `let` DECLARATION with that exact
// initializer, so a later `blkMode = 'enhance'` assignment cannot satisfy it. Expect more of
// these as annotations land: a pin on source SHAPE is not a pin on source MEANING, and this
// milestone keeps finding the difference.
ok(/let blkMode\s*=\s*'cleanup'\s*;/.test(main), "a fresh browser defaults to Clean up (localStorage still wins once you've chosen)");

// the hand-off is Clean up's alone — one direction, so Enhance has nothing to hand on
// ⚠️ THE GROUPING PAREN LEFT THE PRODUCT, AND IT IS THE ONE THING 8.3.2 CHANGED THAT AN AST CAN
// SEE. This read `…display=\(blkMode==='cleanup'`; Prettier dropped the redundant parens around
// the ternary's condition — the single non-whitespace difference across all 133 reformatted files,
// and an expression identical to the one before it. Everything else here is elastic spacing.
// ⚠️ AND IT IS HAND-WRITTEN RATHER THAN `textRe`, DELIBERATELY: the marker starts INSIDE a string
// literal (`blkToEnhanceWrap'`), so relaxSpace reads that stray quote as an opener, swallows
// `).style.display=blkMode===` into one rigid atom and yields a regex that matches nothing at all.
// A silently-unmatchable pattern is the exact failure this repair exists to undo — measured, not
// assumed.
// NOT widened: still that element's `display`, still assigned FROM a `blkMode === 'cleanup'` test,
// so the visibility is still a per-tab decision rather than a static style.
ok(
  /blkToEnhanceWrap'\)\)?\.style\.display\s*=\s*blkMode\s*===\s*'cleanup'/.test(main),
  'Copy to Enhance is shown only on the Clean up tab',
);
ok(
  /id="blkToEnhance"/.test(html) && /class="primary" id="blkToEnhance"/.test(html),
  'Copy to Enhance is a .primary (blue) button, beside the green Download',
);
ok(/handoff\/cleanup-to-enhance/.test(main), 'it posts to the one-way hand-off route');

// ── 8. the SSE stream is CLOSED when a batch ends ────────────────────────────
// _job_sse replays the whole event ring buffer to every connection and then returns at the
// terminal event. So an EventSource that is merely nulled — not closed — reconnects ~1s later
// and gets the entire log replayed, for ever: a finished batch looks like it's still running and
// the panel flips back to Choose Files each time the replayed terminal event re-fires the view
// switch. Other tabs close the stream through endJob().
// (That the close really happens is proved by RUNNING the handlers in §9 below — a regex here
// asserting the shape of blkEndJob is exactly the kind of check that pinned the Cancel bug.)
const blkStream = main.slice(main.indexOf('function blkCloseStream()'));
ok(blkStream.length > 200, 'located the Bulk stream handlers');
// every terminal path must tear down through blkEndJob, never by nulling blk.es by hand.
// Match the whole case BLOCK (up to the next `case`/end), not the line — job_done's teardown
// wraps onto the following line.
const handler = blkStream.slice(blkStream.indexOf('function blkHandleEvent'));
for (const ev of ['job_done', 'error', 'canceled']) {
  const start = handler.indexOf(`case '${ev}'`);
  const rest = handler.slice(start);
  const end = rest.indexOf('break;');
  const block = end > 0 ? rest.slice(0, end) : rest;
  ok(start > 0 && block.includes('blkEndJob()'), `the '${ev}' event tears the stream down via blkEndJob()`);
}
// 🔴 THE EXCISION IS THE WHOLE FUNCTION NOW, NOT ITS FIRST LINE. blkCloseStream is the one place
// that is SUPPOSED to null blk.es, so it has to leave the haystack before a negative over the rest
// can mean anything. It used to be a one-liner, so `/function blkCloseStream\(\)\{[^\n]*\n/` took
// all of it; 8.3.2 spread it over eight lines and that replace then took the header alone, leaving
// its own `blk.es = null` behind — the check would have gone red about code that is correct.
// blkCloseStream is the FIRST definition in `blkStream` (which is sliced at it), so cutting to the
// first column-0 `}` cuts exactly that function and nothing after it. A -1 search leaves the
// haystack whole, so a marker that stops working fails LOUDLY instead of passing over nothing.
// ⚠️ AND THE NEEDLE HAD TO GO ELASTIC OR THIS CHECK WOULD BE GREEN OVER AIR. It is a NEGATIVE
// assertion: pinned to the dense `blk.es=null` it now matches nothing anywhere, which reads as
// "no handler does this" while having quietly lost the ability to notice one that did. Same token
// sequence, `\s*` between the tokens, NOT widened.
const closeEnd = blkStream.search(/^\}/m);
ok(
  !textRe('blk.es=null').test(closeEnd > 0 ? blkStream.slice(closeEnd + 1) : blkStream),
  'no handler nulls blk.es by hand (that is what leaked the reconnect loop)',
);

// ── 9. RUN the stream handlers — shape checks are how the last bug got in ────
// The check above used to assert `blkOpenStream(id){blkEndJob();` — the SHAPE of a fix rather than
// what it does. blkEndJob also nulls blk.jobId, so that "close any previous stream" guard erased
// the job id its own caller had just set, and Cancel (which starts `if(!blk.jobId)return;`) went
// silently dead. The test happily pinned the regression. So drive the real functions instead.
const sFrom = main.indexOf('function blkCloseStream()');
const sTo = main.length;
ok(sFrom > 0 && sTo > sFrom, 'located the Bulk stream handlers to execute');
const sb = {
  blk: { jobId: null, es: null, total: 0, done: 0, mode: 'cleanup' },
  EventSource: class {
    constructor(url) {
      this.url = url;
      this.closed = false;
    }
    close() {
      this.closed = true;
    }
  },
  blkLogLine() {},
  blkProgress() {},
  blkZipping() {},
  blkRenderDone() {},
  blkShow() {},
  blkElapsed: () => '0s',
  esc: s => s,
  jget: async () => ({}),
  JSON,
};
vm.createContext(sb);
vm.runInContext(main.slice(sFrom, sTo), sb);

sb.blk.jobId = 'abc123abc123'; // what blkGo/blkReattach set before opening
sb.blkOpenStream('abc123abc123');
ok(sb.blk.jobId === 'abc123abc123', 'blkOpenStream KEEPS blk.jobId — Cancel reads it, and a null makes the button a silent no-op');
ok(sb.blk.es && sb.blk.es.url === '/bulk/events/abc123abc123', 'blkOpenStream opened the stream');

const first = sb.blk.es; // a second open must close the first
sb.blk.jobId = 'def456def456';
sb.blkOpenStream('def456def456');
ok(first.closed === true, 'opening a new stream closes the previous one');
ok(sb.blk.jobId === 'def456def456', 'and still keeps the NEW job id');

const live = sb.blk.es; // a terminal event ends the job for real
sb.blkHandleEvent({ type: 'canceled' });
ok(live.closed === true && sb.blk.es === null, 'a terminal event CLOSES the stream (no reconnect/replay loop)');
ok(sb.blk.jobId === null, 'and forgets the job — that part is blkEndJob’s alone');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
