// Vocalis 7.0 §6 — the Character Cards / World Books sub-tabs, driven by tests/test_wbedit_ui.py.
//
// test_wbedit_routes.py talks to the ROUTES. Nothing there would notice that the sub-tabs landed
// in the wrong order, that the two renames never happened, that a document's NAME reaches the
// page unescaped, that the SSE handler renders a body the frame does not carry, or that the
// shell is still 1080px so the two diff panes get ~520px each.
//
// No npm dependencies (the devices_ui_smoke.mjs / clips_ui_smoke.mjs convention).
//
// Usage: node wbedit_ui_smoke.mjs <path-to-index.html>
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { readPage, textRe } from './_websrc.mjs';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node wbedit_ui_smoke.mjs <index.html>');
  process.exit(2);
}

// Normalized to LF — a CRLF checkout silently zeroes out newline-anchored regexes and every
// check below then reads as passing. (voices_ui_smoke.mjs learned this the hard way.)
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

/**
 * The offset of the code fragment `code` within `src`, matched whitespace-elastically. 8.3.2.
 *
 * 🔴 THE SPACING WAS THE SYMPTOM; `indexOf` WAS THE HAZARD. Two slices below were bounded by
 * `lib.indexOf('}catch')`, and 8.3.2's Prettier pass writes that as `} catch (e) {`. A miss returns
 * -1, `slice(-1)` hands back the last CHARACTER of the function, and three checks then fail
 * complaining about the page — a failure whose real cause is the marker and which reads as a
 * product bug. That is exactly the silent-garbage shape tests/_websrc.mjs was written to end, so
 * this borrows its matcher (`textRe`, elastic between tokens, rigid inside string literals) and
 * throws with the fragment named rather than sliding past.
 */
const at = (src, code) => {
  const m = textRe(code).exec(src);
  if (!m) {
    throw new Error(
      `wbedit_ui_smoke: could not locate ${JSON.stringify(code)} in the slice. If the code was ` +
        'renamed or deleted that is a real finding — fix the fragment, do not delete the check.',
    );
  }
  return m.index;
};

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
// 🔴 THE LONGEST inline block, NOT the last one. 7.1 (DESIGN_7_1_FRONTEND_REFACTOR.md §5.3) adds
// `<script type="module">` tags to the page, and the first one to land sat AFTER the app script —
// so `blocks.length - 1` silently selected a three-line shim and every slice below resolved to -1.
// That is not a hypothetical: it turned this spec red the moment the first module was extracted.
// The app script is the big one by three orders of magnitude, and it stays the big one until the
// split finishes, at which point there is no inline app script and these specs need rewriting
// against the real DOM anyway (§5's own note).
const main = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

// ── following the code out of the page (7.1) ─────────────────────────────────
//
// 🔴 EVERY SLICE BELOW USED TO ASSUME ONE HAYSTACK, AND THE SPLIT IS MOVING FUNCTIONS OUT OF IT.
// A slice whose start marker has emigrated to a module returns `''` — `indexOf` gives -1, the
// slice comes back empty, and `/whatever/.test('')` is false. So the failure mode is a RED check
// that names the wrong cause ("the SSE handler reads a body off the frame" when the handler is
// simply somewhere else), and the fix that suggests itself is to delete the check. The haystack is
// therefore the page's inline script PLUS every module on disk, and each slice finds the one it
// lives in.
//
// ⚠️ THE LOOKUP IS BY DEFINITION, ANCHORED TO A LINE START, AND THAT IS NOT FUSSINESS. A plain
// `includes('function wbStream')` matches index.html's own comment about this spec — the one
// warning that `wbCloseStream` must not shadow it, which quotes `indexOf('function wbStream')`
// verbatim. Searching for a mention finds the warning, picks the wrong file, and slices garbage.
// A definition is always at column 0 in both the page and a module.
const jsRoot = join(dirname(htmlPath), 'js');
const walk = async dir => {
  let out = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await walk(p));
    else if (e.name.endsWith('.js')) out.push((await readFile(p, 'utf8')).replace(/\r\n/g, '\n'));
  }
  return out;
};
const sources = [main, ...(await walk(jsRoot))];

// `sig` is the definition without its parameter list — 'function wbStream', 'async function wbRun',
// 'const esc'. `export` is optional so the same marker works before and after a move.
const defRe = sig => new RegExp('^(?:export\\s+)?' + sig.replace(/\s+/g, '\\s+') + '\\b', 'm');
const sourceOf = sig => sources.find(s => defRe(sig).test(s));

// The text from one definition to the next. When the end marker is absent from the same file — the
// normal case once a module ends after the function — the slice simply runs to the end of it.
const sliceDef = (startSig, endSig) => {
  const src = sourceOf(startSig);
  // 🔴 SAY WHICH MARKER WENT MISSING, rather than returning '' and letting three unrelated checks
  // fail for a reason none of them names. A renamed or deleted function is a real finding; being
  // told "the SSE handler reads a body off the frame" when it does not is how a good check gets
  // deleted by someone reasonably concluding it is broken.
  if (!src) {
    ok(false, `\`${startSig}\` is defined somewhere (page or module)`);
    return '';
  }
  const a = src.match(defRe(startSig)).index;
  const m = src.slice(a).match(defRe(endSig));
  return m ? src.slice(a, a + m.index) : src.slice(a);
};

// ── 1. the sub-tab strip (§6.0) ──────────────────────────────────────────────
const ststrip = html.slice(html.indexOf('id="stTabs"'), html.indexOf('class="stwrap"'));
const storder = [...ststrip.matchAll(/data-sttab="([a-z]+)"/g)].map(m => m[1]);
ok(
  storder.join(',') === 'logs,characters,cards,books,personas,clips',
  `the sub-tabs read Logs · Character Voices · Character Cards · World Books · Personas · Scene Clips (${storder.join(' · ')})`,
);

// 🔴 Distinguish the voice-assignment tab from the adjacent Character Cards editor; their similar
// old labels obscured that they perform different jobs.
ok(/data-sttab="characters"[^>]*>Character Voices</.test(ststrip), 'the voice tab is called "Character Voices", not "Characters" (§6.0)');
ok(/data-sttab="clips"[^>]*>Scene Clips</.test(ststrip), 'the clips tab is called "Scene Clips" (§6.0)');
ok(
  /data-sttab="cards"[^>]*>Character Cards</.test(ststrip) && /data-sttab="books"[^>]*>World Books</.test(ststrip),
  'the two sub-tabs have their expected names',
);

// 🔴 Both panes must live INSIDE the SillyTavern section. switchTab() hides every
// `section[data-panel]` that is not current, so an stpanel left outside is hidden by the
// top-level switch and never comes back — the sub-tab would open onto nothing.
{
  const sect = html.indexOf('<section data-panel="sillytavern"');
  const end = html.indexOf('</section>', sect);
  for (const k of ['cards', 'books']) {
    const pane = html.indexOf(`data-stpanel="${k}"`);
    ok(sect > 0 && pane > sect && pane < end, `the ${k} pane is nested inside the SillyTavern section, where switchTab can reach it`);
  }
}

// ── 2. the global width (§6.0.1) ─────────────────────────────────────────────
//
// 🔴 Set the shell width globally so switching between tabs does not change card geometry. At
// 1800px, a side-by-side layout gives each pane about 880px.
ok(!/main\{max-width:1080px/.test(html), 'the 1080px shell is gone (§6.0.1)');
ok(/--shell:\s*1800px/.test(html), 'the width is a CSS custom property now, declared once');
ok(/main\{max-width:var\(--shell\)/.test(html), 'main uses it');
ok(/<footer[^>]*max-width:var\(--shell\)/.test(html), 'and so does the footer — it was the SECOND hand-written 1080 (§6.0.1)');
const widths = [...html.matchAll(/max-width:\s*1080px/g)];
ok(widths.length === 0, `no hand-written 1080 survives (${widths.length} found)`);

// ── 3. the helpers, executed ─────────────────────────────────────────────────
const ctx = { console, setTimeout, clearTimeout, document: undefined };
vm.createContext(ctx);
const grab = name => {
  const src = sourceOf(`function ${name}`);
  // ⚠️ `export` is stripped before the body runs. `vm.runInContext` compiles a CLASSIC script, and
  // an `export` keyword there is a SyntaxError — which would present as "the diff is broken"
  // rather than as "this helper is now a module export".
  //
  // 🔴 STRIPPED WITH /gm, NOT ONCE, AND THE REASON IS A ONE-LINER. The match ends at the first
  // `\n}`, so a function whose whole body is on its declaration line — `wbEstimate` is
  // `function wbEstimate(c,f){ return …; }` — has no `\n}` of its own and the match runs ON to the
  // NEXT function's closing brace, swallowing it whole. That was harmless while everything was
  // inline (the vm just got two functions instead of one), and became a SyntaxError the moment
  // the second one carried an `export`. Stripping only the first left `export function wbMins`
  // sitting in the middle of the snippet.
  const m = src && src.match(new RegExp(`^(?:export )?function ${name}\\s*\\([\\s\\S]*?\\n\\}`, 'm'));
  if (!m) {
    ok(false, `${name}() is in the page`);
    return false;
  }
  vm.runInContext(m[0].replace(/^export /gm, ''), ctx);
  return true;
};
// `esc` first: wbDiff() calls it on every span, and a sandbox without it throws a
// ReferenceError that looks like a bug in the diff.
{
  const src = sourceOf('const esc');
  const m = src && src.match(/^(?:export )?const esc\s*=[\s\S]*?;\n/m);
  ok(!!m, 'esc() is in the page (the pane leans on it)');
  if (m) vm.runInContext(m[0].replace(/^export /, ''), ctx);
}

// The preflight estimate. 🔴 PINNED TO AN OBSERVED RUN (7.0-m1d, GLM-Steam-106B at IQ4_XS):
// ~9.5s at 150 chars, ~15s at 800, ~26s at 1600, ~6s for a NOCHANGE. Never ship an untimed
// constant — and never let one drift silently into a number nobody measured.
if (grab('wbEstimate')) {
  const one = ctx.wbEstimate(150, 1);
  const many = ctx.wbEstimate(110 * 600, 110);
  ok(one >= 6 && one <= 20, `a 150-char field is estimated at ${one}s (measured ~9.5s)`);
  ok(many > 600, `a 110-entry book is estimated at ${Math.round(many / 60)} min, not seconds`);
  ok(ctx.wbEstimate(0, 0) === 0, 'nothing selected estimates zero');
}

// The word diff. It only COLORS — the server sends the whole field (I4) and this must never
// become a merge.
if (grab('wbDiff')) {
  const d = ctx.wbDiff('Test Character 1 keeps the ledger.', 'Renamed Character 1 keeps the ledger.');
  ok(/<del>/.test(d.before) && /<ins>/.test(d.after), 'the diff marks the changed span');
  ok(
    /keeps the ledger\./.test(d.after) && !/<ins>[^<]*keeps the ledger/.test(d.after),
    'the unchanged tail is NOT marked — a diff that highlights everything highlights nothing',
  );
  // 🔴 ESCAPED ON THE WAY IN. A worldbook entry is arbitrary user text and it lands in
  // innerHTML; `<script>` in an entry must not become a script tag.
  const x = ctx.wbDiff('<script>alert(1)</script> a', '<script>alert(1)</script> b');
  ok(!/<script>/.test(x.before) && /&lt;script&gt;/.test(x.before), 'field text is escaped on the way into the diff');
  const same = ctx.wbDiff('identical text', 'identical text');
  ok(!/<del>[^<]/.test(same.before), 'an unchanged field marks nothing');
}

// ── 4. I16, in the browser half ──────────────────────────────────────────────
//
// 🔴 The SSE handler must NOT render a body out of the frame — the frame does not carry one,
// so code that reads `e.original` / `e.revised` would render `undefined` forever AND would be
// the exact shape that tempts someone to "fix" it by putting bodies in the frame.
{
  const stream = sliceDef('function wbStream', 'function wbFinish');
  ok(stream.length > 0, 'wbStream() is in the page');
  ok(!/e\.(original|revised|notes)\b/.test(stream), 'the SSE handler reads no body field off the frame (I16)');
  ok(/wbFetchProposal\(/.test(stream), 'it fetches the announced proposal over the document route instead');
}

// ── 5. escaping, everywhere user text reaches the page ───────────────────────
{
  const lib = sliceDef('async function wbLoadLib', 'async function wbImport');
  ok(/esc\(d\.name\)/.test(lib), "a document's NAME is escaped into the Library row");
  const prop = sliceDef('function wbAddProposal', 'function wbMarkVerdict');
  ok(/esc\(p\.label\)/.test(prop), "a proposal's LABEL is escaped into the review row");
  ok(/esc\(p\.status\)/.test(prop), '…and so is its status');
}

// ── 6. I9 — X entries are edited like any other ──────────────────────────────
//
// The review queue may collapse X panes by default, but this is only a display choice. The pane
// remains present and approvable like any other entry.
{
  const prop = sliceDef('function wbAddProposal', 'function wbMarkVerdict');
  ok(/\/\^X-\/i\.test\(p\.label\)/.test(prop), 'an X-titled proposal is recognized');
  ok(/wbpanes/.test(prop) && /display:none/.test(prop), '…and its panes are rendered but folded — present, not withheld');
  ok(!/continue|return;/.test(prop.split('wbx')[0] || ''), 'nothing skips an X entry on the way into the queue (I9)');
}

// ── 7. the one-pass gate, reported rather than swallowed (I12) ───────────────
{
  // ⚠️ THE END MARKER USED TO NEED `'function wbStream('` WITH THE PAREN: `wbCloseStream` sits
  // earlier in the file and a bare `indexOf('function wbStream')` matched a PREFIX of the wrong
  // function, slicing backward to an empty string and failing both checks below against code
  // that had not changed. `sliceDef` anchors to a line start and searches forward from the start
  // marker, so neither the prefix nor the backward slice is reachable any more.
  //
  // ⚠️ AND `wbStream` NOW LIVES IN A DIFFERENT FILE FROM `wbRun`, so there is no end marker in
  // `wbRun`'s source at all — the slice runs to the end of the inline script. Both checks below
  // are `.test()` for a string that only `wbRun` contains, so a longer slice cannot make them
  // pass falsely; it could only mask a DELETION of the 409 branch if some other function grew
  // one. Cheap to tighten if that ever happens: name the function that follows `wbRun`.
  const run = sliceDef('async function wbRun', 'function wbStream');
  ok(/status === 409/.test(run), 'a 409 from /pass is recognized as "one is already running"');
  ok(/already running/i.test(run), '…and says so, rather than leaving the button looking dead');
}

// ── 8. the locked vault (I15) ────────────────────────────────────────────────
{
  const lib = sliceDef('async function wbLoadLib', 'async function wbImport');
  // Either comparison — the branch may test for 423 or early-return everything that is not it.
  // ⚠️ This is a regex over source text and it can only ever say the number is MENTIONED. What
  // the 423 actually DOES is asserted in wbedit_browser_spec.mjs, which injects one and watches
  // the pane say "locked" and then heal itself; when the two disagree, believe the browser.
  ok(/status\s*[!=]==\s*423/.test(lib), 'a 423 is recognized');
  // 🔴 Scoped to the CATCH BLOCK. The empty-state string legitimately appears earlier in the
  // same function (an empty library is a real answer); asserting over the whole function just
  // finds it there and reports a failure that is a property of the regex, not the page.
  const cat = lib.slice(at(lib, '}catch'));
  ok(/locked/i.test(cat), 'the failure path says "locked"');
  ok(!/Nothing imported yet/.test(cat), 'a locked vault never renders "nothing imported yet" — that would state an unreadable as a fact');
}

// ── 9. the pane is wired ─────────────────────────────────────────────────────
{
  // 🔴 NOT `main` ANY MORE. `wbWire` and its three calls left the page in 7.1-m13 for
  // `js/wb/wire.js`, so a check against the inline script would go red for the right reason
  // while naming the wrong one — "the sub-tabs are not wired" when they are, in another file.
  // `sourceOf` follows the definition wherever it lives, which is what the whole §5 haystack
  // above exists for.
  const wire = sourceOf('function wbWire');
  ok(!!wire, '`wbWire` is defined somewhere (page or module)');
  // 🔴 THE CALLS ARE ASSERTED WITH THE DEFINITION, IN THE SAME FILE. `wire.js` exports nothing —
  // these three statements are its entire reason to be imported — so a definition that arrived
  // without them is a module that loads, wires nothing, and fails no other check here.
  ok(!!wire && ['cards', 'books', 'personas'].every(k => new RegExp("wbWire\\('" + k + "'\\)").test(wire)), 'all three sub-tabs are wired');
}
// ⚠️ AGAINST THE FILE THAT DEFINES `switchStTab`, NOT `main` — 7.3-m2b moved it into
// js/st/tabs.js with the rest of the SillyTavern sub-tab strip, and `main` is the page's inline
// block alone. This file already has a `sourceOf` that searches the page AND every module; the
// check was simply written before that existed.
// 7.5.6 — `stTabApply`: the dispatch kept its body and lost its export, because the name is
// js/st/tabstate.js's dispatcher now (js/st/tabs.js <-> js/scenes/scenes.js was a cycle).
const stTabsSrc = sourceOf('function stTabApply') || '';
ok(
  /case 'cards'|name==='cards'/.test(stTabsSrc) && /wbLoadLib\('cards'\)/.test(stTabsSrc),
  'switchStTab loads the Character Cards pane when you open it',
);

// ── 10. §8.2 — filter the Character Cards roster by worldbook (m2f) ──────────
//
// Filter the Character Cards roster by its associated worldbook.
//
// ⚠️ Everything here is a regex over source and can only prove a thing is MENTIONED. That the
// filter actually narrows the roster, and that renaming the book does not break it, is asserted
// in wbedit_browser_spec.mjs against a real browser. When the two disagree, believe the browser.
{
  // The control is on the CARDS pane only. A worldbook has no worldbook of its own, so a copy
  // of this control on the Books pane would be a filter that can only ever return everything.
  const cards = html.slice(html.indexOf('data-stpanel="cards"'), html.indexOf('data-stpanel="books"'));
  const books = html.slice(html.indexOf('data-stpanel="books"'));
  ok(/id="wbBook_cards"/.test(cards), 'the worldbook filter is on the Character Cards pane');
  ok(!/id="wbBook_books"/.test(books), '…and NOT on the World Books pane, which has nothing to filter by');

  const filt = sliceDef('async function wbLoadBookFilter', 'async function wbLoadLib');
  ok(filt.length > 0, 'wbLoadBookFilter() is in the page');
  // 🔴 THE OPTION VALUE IS THE BOOK'S ID, NEVER ITS NAME. This is the whole of §8.2 in one
  // line: an id survives a rename and a name does not. A filter keyed on the name would work
  // perfectly until the first rename and then silently return an empty roster.
  ok(/value="\$\{esc\(d\.id\)\}"/.test(filt), 'each option carries the book ID as its value');
  ok(/esc\(d\.name\)/.test(filt), "…and the book's NAME is escaped into its label");
  ok(/kind=worldbook/.test(filt), 'the options come from the worldbook documents');

  const lib = sliceDef('async function wbLoadLib', 'async function wbImport');
  ok(/world=/.test(lib), 'wbLoadLib sends the chosen book to the Library route');
  // 🔴 An empty filtered result is different from an empty library. Report that the filter matched
  // nothing so users do not mistake it for missing imported content.
  const empty = lib.slice(at(lib, 'if(!r.documents.length)'), at(lib, '}catch'));
  ok(/associated/i.test(empty), 'an empty FILTERED roster says the filter matched nothing, not that the library is empty');
  ok(/filtered/.test(empty) || /wbBookFilter/.test(empty), '…and it distinguishes the two cases rather than printing one message for both');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
