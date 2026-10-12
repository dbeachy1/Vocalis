// Vocalis 4.8-m3 — the Voices tab's render helpers, driven by tests/test_voices_ui.py.
//
// test_server.py and test_voxcpm.py talk to the ROUTES. Nothing there would notice that the
// Create tab quietly went back to listing all 27 uploaded voices, that the Seed box came back,
// that a candidate row grew an Overwrite button again, or that the list heading kept saying
// "Voices" while showing only half of them — and each of those is a specific thing §14 spent
// pages deciding. So the real helpers are sliced out of the real index.html and exercised.
//
// No npm dependencies (the kobold_ui_smoke.mjs / stems_widget_smoke.mjs convention).
//
// Usage: node voices_ui_smoke.mjs <path-to-index.html>
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
// ✅ 7.3-m8b1: EVERY SLICE IN THIS FILE NOW GOES THROUGH THE SHARED LOADER. It was `decl()` alone at
// m4o, with a note saying the forty-odd `main.indexOf` slices were "not this commit" (§11.6 item 4);
// m4q, m6b and m6c each converted one more because a cut had just broken it. The remaining twelve
// went together, BEFORE the cut that would break them — see the note on `anywhere` below.
// ✅ 8.3.2: `textRe` JOINS THEM. Prettier respaced every module, and ~35 of the greps below were
// written against the dense style (`const commit=vcBin.tokens;`) — they pinned the ABSENCE of
// whitespace, which is not what any of them was asserting. `textRe(literal)` re-anchors on the same
// token sequence with the spacing between tokens made elastic, and stays rigid exactly where JS
// says whitespace matters (never between two identifier characters, never inside a string literal).
// Every conversion below is a RE-ANCHOR, not a widening: nothing new becomes matchable but respacing.
import { readPage, loadWebSources, sliceDef, sliceText, sourceOf, sourceOfOrNull, stripModuleSyntax, textRe } from './_websrc.mjs';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node voices_ui_smoke.mjs <index.html>');
  process.exit(2);
}

// Normalized to LF. Git checks this file out with CRLF on Windows (core.autocrlf), and the
// structural regexes below anchor on newlines — JS counts a carriage return as a line
// terminator, so `.` and `$` stop where it sits and every match silently drops to zero. That
// failed this suite once for a reason that had nothing to do with the UI. Normalize on read.
// The page AS SERVED: index.html with its stylesheets inlined. Every CSS assertion
// below depends on that - those rules left this file for src/webui/css/ at 7.3.19.
const html = await readPage(htmlPath);
await loadWebSources(htmlPath); // the corpus `decl()` searches: the page plus every module
let failed = 0;
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    console.error(`  FAIL ${what}`);
    failed++;
  }
};

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
// 🔴 THE LONGEST inline block, NOT the last one. 7.1 (DESIGN_7_1_FRONTEND_REFACTOR.md §5.3) adds
// `<script type="module">` tags to the page, and the first one to land sat AFTER the app script —
// so `blocks.length - 1` silently selected a three-line shim and every slice below resolved to -1.
// That is not a hypothetical: it turned this spec red the moment the first module was extracted.
// The app script is the big one by three orders of magnitude, and it stays the big one until the
// split finishes, at which point there is no inline app script and these specs need rewriting
// against the real DOM anyway (§5's own note).
const inlineApp = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

// 🔴 7.3-m4b: THE CANDIDATE QUEUE NOW LIVES IN js/voice/candidates.js, so "the application's
// script" is the inline block PLUS that module — which is what every slice in this file has always
// meant. Appending it is the devices_ui_smoke.mjs pattern and it keeps each `indexOf` below finding
// its target wherever the split has currently put it. Eleven definitions moved: vcN, vcPoll,
// loadCandidates, vcRenderCandHead, vcRowHTML, renderCandidates, vcClipDead, vcWirePlayback,
// vcAnyPlaying, promptVoiceName and vcDelete.
//
// ⚠️ THE ONE WAY THIS GOES WRONG IS A NEEDLE THAT STRADDLES THE JOIN — a slice whose start is in
// the page and whose end is in the module runs from the start marker all the way to the end of the
// inline block and on into the module, which is a slice thirty times the size of the one asked
// for. A negative check over it then goes red for text it was never about, and a positive one can
// pass on code from a different feature. `genSrc` was the one straddler here and is re-anchored on
// `$('vcBatchBtn').onclick` below. There is no automatic protection: check both ends.
//
// ⚠️ AND A NEEDLE PRESENT IN BOTH HALVES RESOLVES TO THE INLINE ONE, because that half comes
// first. Checked for every needle this file uses — none of the eleven is still defined in the page.
//
// 🔴 `export ` IS STRIPPED, and it is not cosmetic: vm.runInContext() compiles a CLASSIC script,
// so one leaked keyword is `SyntaxError: Unexpected token 'export'` and every check after it never
// runs. A slice's START needle is safe by itself; its END needle is not, because an `indexOf`
// landing on an exported declaration sits PAST the `export ` and keeps those seven characters as
// the slice's tail. That is how kobold_ui_smoke.mjs broke in m4.
const candPath = join(dirname(htmlPath), 'js', 'voice', 'candidates.js');
const batchPath = join(dirname(htmlPath), 'js', 'voice', 'batch.js');
const lf = async f => (await readFile(f, 'utf8')).replace(/\r\n/g, '\n').replace(/^export /gm, '');
const candJs = await lf(candPath);
const batchJs = await lf(batchPath);

// ✅ 7.3-m8b1: `main` IS GONE, AND WITH IT THE HAND-MAINTAINED CONCATENATION ABOVE.
//
// It was `inlineApp + candJs + batchJs`, grown by hand once per extraction, and both halves of it
// were wrong in a way the note above predicted: every `main.indexOf(…)` slice could STRADDLE THE
// JOIN, and every `.test(main)` claim needed a third file appending the day the voices block itself
// moved (m8b, the next commit). Neither problem has a warning attached to it — a straddling slice is
// thirty times too big and a missing file makes a negative check pass.
//
// The two halves are separated now, and each does one job:
//
//   `anywhere` — the WHOLE front end (page + every module under js/), for "this logic exists"
//                claims. Same name and same meaning as tests/clips_ui_smoke.mjs's. A superset of
//                the old `main`, so no claim below got weaker; the ones that would have needed a
//                fourth and fifth file appended now need nothing.
//   sliceDef /  — every slice that used to be `main.slice(main.indexOf(a), main.indexOf(b))`. These
//   sliceText     are PER-FILE, so a straddle is impossible by construction, and a marker that has
//                 been renamed or deleted throws with its own name in the message instead of
//                 answering -1 and slicing the rest of the file (§3.5, _websrc.mjs's header).
//
// ⚠️ SEVEN `ok(…, 'located …')` PRECONDITIONS WENT WITH IT, which is why this file's check count
// falls from 235 to 228 without losing a single assertion about the UI: `sliceDef` throwing IS that
// check, and it names the marker. _websrc.mjs's header says to drop them rather than wrap the call
// in a try/catch to keep the counter tidy. 📌 The EIGHTH was restated instead of dropped — the
// voice-list one carried a real claim (the order helpers precede the renderer) that a thrown
// `sliceDef` does not make, so it is a containment check on the slice now. Read each one before
// deleting it; some of them are only preconditions.
//
// 📌 The four already-converted slices (`decl`, `genSrc`, `voicesJs`, `voiceOptionsHTML`) went this
// way one at a time across m4o, m4q, m6b and m6c, each because a cut had just broken it. This is the
// same conversion done for the remaining twelve BEFORE the cut that would break them, which is what
// §7 item 1 asked for and what "green before and after" means.
const anywhere = (await loadWebSources(htmlPath)).files.map(f => f.text).join('\n');

// ── 1. markup facts: the controls §14 deleted must STAY deleted ──────────────
// The two parameters are still named and still in that order — only the spacing between them is
// elastic. `lf()` above has already stripped `export `, so the column-0 anchor still means what it
// meant: the module DEFINES vcN, it does not merely mention it.
ok(/^function\s+vcN\s*\(\s*n\s*,\s*noun\s*\)/m.test(candJs), `read the candidate-queue module at ${candPath}`);
ok(/^async function vcBatchPoll\(/m.test(batchJs), `read the overnight-batch module at ${batchPath}`);
ok(
  !/^(?:async )?function (?:vcN|vcPoll|loadCandidates|renderCandidates|vcDelete|vcBatchPoll|vcBatchForm|vcRenderBatch)\(/m.test(inlineApp),
  '🔴 …and the page no longer defines any of it — one declaration, never two (§11.4)',
);
ok(!/id="vcSeed"/.test(html), 'the Seed input is gone (§14.2 — an implementation detail wearing a label)');
ok(!/blank = two at once/.test(html), 'and so is the "blank = two at once" hint that explained it');
ok(/data-vtab="upload"/.test(html) && />Upload a voice</.test(html), 'the first sub-tab is "Upload a voice" (was "Add a voice")');
ok(/id="vListTitle"/.test(html), 'the voices list has a retitleable heading (Uploaded/Created)');
ok(
  /id="vAddName"/.test(html) && !/Name \(optional\)/.test(html),
  'the upload name field is no longer labeled optional — it is the identity',
);

// ── 2. renderVoiceList: filtered by origin, titled by origin ─────────────────

const els = {};
// querySelector returns null: renderVoiceList now detaches the open shared player before it
// rewrites #vList and puts the same node back afterward (so a re-render cannot destroy a
// playing element — see tests/voices_player_browser_spec.mjs). In this string-level harness
// there is never a player open, so "none" is the honest answer and the render is unaffected.
// querySelectorAll returns []: renderCandidates wires play-next-on-end over the <audio> elements
// it just wrote (vcWirePlayback). There are no real elements in a string-level harness, so "none"
// is the honest answer — the ORDERING that feature depends on is a property of the rendered HTML,
// which is what the assertions below read. The real playback wiring is browser-spec territory.
const el = id =>
  (els[id] ||= {
    id,
    innerHTML: '',
    textContent: '',
    dataset: {},
    style: {},
    checked: false,
    disabled: false,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
const sandbox = {
  console,
  $: el,
  document: { querySelectorAll: () => [] },
  esc: s =>
    String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
  fmtSize: n => `${n} B`,
  FILT: {},
  filtQ: id => (sandbox.FILT[id] || '').trim(),
  filtRows: (id, rows, text) => {
    const q = sandbox.filtQ(id);
    return q ? rows.filter(r => String(text(r)).toLowerCase().includes(q.toLowerCase())) : rows;
  },
  filtNone: () => '<span class="muted">nothing matches</span>',
  filtCount: (id, n, all, noun) => (!all ? '' : `— ${n < all ? `${n} of ${all}` : n} ${noun}${n === 1 ? '' : 's'}`),
  state: {},
  vcTab: 'upload',
  // Like vcTab: the real `let vSort` sits just above the slice, so the sandbox owns it and
  // the test can flip the order. Its PERSISTENCE is checked against the source instead (§6).
  vSort: 'added',
  fmtDate: ts => `D${ts}`,
  encodeURIComponent,
};

// 4.8-m5: the renderer now leans on vocabulary declared elsewhere in the file — the ★ button
// (4.2-m0e) and the shared picker order (§16.9). Pull the REAL declarations in rather than
// restating them here; a local copy would keep passing after the original changed.
//
// 🔴 7.3-m4o: THAT "ELSEWHERE" IS NO LONGER ALWAYS THE PAGE. favBtn and favFirst moved to
// js/ui/fav.js, and searching `main` alone finds neither. Sabotage-verified by putting the old
// one-corpus lookup back: 14 ok, 2 FAIL, and then `renderVoiceList` throws ReferenceError on the
// first ★ and node dies — taking the remaining 223 checks with it, unreported. Two named failures
// hiding 223 unrun ones is §3.5's failure exactly. `sourceOfOrNull` searches
// the page AND the whole module tree, and `?? main` keeps the four names that have NOT moved
// (voiceSortName, byVoiceName, voiceOptText, voiceOrder) resolving out of the appended-module `main`
// this file builds, which _websrc.mjs's own corpus does not include.
//
// ⚠️ PRESENCE IS THE ASSERTION HERE, not a precondition, so this keeps its `ok` and uses
// sourceOfOrNull rather than the throwing sourceOf — _websrc.mjs's header names this exact case.
// ⚠️ And `export ` is stripped: vm.runInContext compiles a CLASSIC script, where one leaked keyword
// is a SyntaxError that takes every check after it with it.
// ⚠️ 8.3.2 — `const ${name}=` PINNED THE DENSE SPACING, and this is the one that cascades. Prettier
// writes `export const favFirst = a => …`, so the old regex matched nothing, `decl` returned '', the
// prelude was empty and `renderVoiceList` died on `ReferenceError: favFirst is not defined` — taking
// every check after it with it, which is the exact failure mode the m4o note above describes.
// The claim is unchanged and is still three things: a COLUMN-0 declaration (so a mention inside
// another expression cannot answer), of `const <name>`, running to the first line that ends in `;`.
// Only the whitespace it tolerates moved.
const decl = name => {
  const src = sourceOfOrNull(`const ${name}=`) ?? anywhere;
  const m = new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=[\\s\\S]*?;$`, 'm').exec(src);
  ok(!!m, `located the real declaration of ${name}`);
  return m ? m[0].replace(/^export\s+/, '') : '';
};
// 8.9 — the same claim for a FUNCTION declaration. `folderRows` and `folderBar` are
// `export function`, not `export const`, so `decl`'s regex cannot answer for them; everything
// else about the assertion is identical (a COLUMN-0 declaration of that exact name, so a mention
// inside another expression cannot satisfy it). It runs to the first `}` at column 0, which is
// where a top-level function declaration ends in this tree's formatting.
const declFn = name => {
  const src = sourceOfOrNull(`function ${name}(`) ?? anywhere;
  const m = new RegExp(`^(?:export\\s+)?function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}$`, 'm').exec(src);
  ok(!!m, `located the real declaration of ${name}`);
  return m ? m[0].replace(/^export\s+/, '') : '';
};
// 🔴 THE REAL FOLDER HELPERS, NOT LOCAL COPIES — the rule the m4o note above spells out. The
// pre-8.9 assertions in this file now run THROUGH `folderRows`, so a change to the grouping that
// broke the ordinary flat list would be caught here rather than only in a browser.
const prelude = [
  ...['favBtn', 'favFirst', 'voiceSortName', 'byVoiceName', 'voiceOptText', 'voiceOrder', 'folderGap', 'folderTag', 'dragRefs'].map(decl),
  ...['folderRows', 'folderBar'].map(declFn),
].join('\n');

// The three accessors those two lean on are module-private in js/ui/folders.js: they read a fetch
// cache and `UIS`, neither of which exists in a classic-script sandbox. So the sandbox owns them,
// which is also what lets the tests below DRIVE the folder state instead of mocking the output.
sandbox.VFOLDERS = [];
sandbox.VOPEN = '';
sandbox.foldersOf = () => sandbox.VFOLDERS;
sandbox.folderOpen = () => sandbox.VOPEN;
sandbox.folderName = (_scope, fid) => (sandbox.VFOLDERS.find(f => f.id === fid) || {}).name || '';

// 9.7.2 — `renderVoiceList` now re-arms `🗑 Delete selected` after it prunes the tick set.
//
// 🔴 A COUNTER, NOT A NO-OP, AND THE DIFFERENCE IS THE WHOLE POINT. The sandbox has to supply this
// (it is module-private and reads a DOM node this sandbox does not have), and the lazy version is
// `() => {}` — which would let the call be DELETED from `renderVoiceList` with every check here
// still green. The prune is the one place a tick vanishes without anyone touching a checkbox, so
// dropping the sync leaves the button reading "(6)" over a selection the same render cut to two.
// Counting turns a stub that hides a regression into one that catches it.
sandbox.__bulkSyncs = 0;
sandbox.vSyncBulk = () => {
  sandbox.__bulkSyncs++;
};

vm.createContext(sandbox);
// From vOrder (not renderVoiceList) so the list's own order and date helpers come along.
// ⚠️ `sliceText`, not `sliceDef`: the end statement now begins with m10's cast comment, so it is
// no longer at column 0 where a definition anchor looks. The parenthesized form is unique in the
// file (checked), which is what makes the unanchored search safe here.
const vhSrc = stripModuleSyntax(sliceText('const vOrder=list=>', "($('vRefresh')).onclick"));
// ⚠️ THE ORDER CLAIM SURVIVES THE CONVERSION, restated as containment rather than as two offsets:
// the slice must actually REACH the renderer, or the helpers arrive in the sandbox and the thing
// under test does not. The old form compared `vhFrom < rvlFrom`; this cannot be satisfied by a
// slice that stops short.
// Still the same three-part claim after the respace: a COLUMN-0 function declaration, of that
// name, taking NO parameters — `\(\s*\)` keeps the empty parameter list, it did not become `\(`.
ok(
  /^(?:export\s+)?function\s+renderVoiceList\s*\(\s*\)\s*\{/m.test(vhSrc),
  'the voice-list order helpers sit above renderVoiceList, in the same file',
);
vm.runInContext(prelude + '\n' + vhSrc, sandbox);

sandbox.state.vlist = [
  { name: 'Narrator_2.wav', size: 10, label: '', origin: 'uploaded' },
  { name: 'Test_Voice_2.mp3', size: 20, label: 'Test Voice 2 — bright', origin: 'uploaded' },
  { name: 'Test_Voice_1.wav', size: 30, label: 'Test Voice 1', origin: 'created' },
];

// 🔴 `vcTabNow()`, NOT A BARE `vcTab`, SINCE 7.5.6. The `let` moved to js/voices/vcstate.js so
// that js/sys/model.js, js/voice/batch.js and js/voice/candidates.js could stop importing
// js/voices/voices.js — a four-module cycle. The sliced source calls the accessor, and this
// sandbox is not a module system, so the accessor has to be supplied here.
// ⚠️ Keep `sandbox.vcTab` as the backing value: every assignment below still writes it, and
// the accessor reads it, so the tests that switch sub-tab keep working unchanged.
sandbox.vcTabNow = () => sandbox.vcTab;
sandbox.vcTab = 'upload';
sandbox.renderVoiceList();
let out = el('vList').innerHTML;
ok(sandbox.__bulkSyncs > 0, '🔴 rendering the list re-arms 🗑 Delete selected — the prune is where a tick silently disappears');
ok(el('vListTitle').textContent === 'Uploaded voices', 'the Upload tab heading reads "Uploaded voices"');
ok(/— 2 voices/.test(el('vTotals').textContent), 'and counts only the uploaded ones (2, not 3)');
ok(out.includes('Narrator_2.wav') && out.includes('Test_Voice_2.mp3'), 'both uploaded voices are listed');
ok(!out.includes('Test_Voice_1.wav'), '🔴 the CREATED voice is NOT on the Upload tab');
// The label is the identity, but an UNLABELED voice keeps its full filename — extension and
// all. Existing unlabeled rows keep their original filename, including its extension.
ok(/class="t">Narrator_2\.wav</.test(out), 'an unlabeled voice shows its FULL filename as the title, extension included');
ok(/class="t">Test Voice 2 — bright</.test(out), 'a labeled voice shows its label as the title');
ok(/class="m">Narrator_2\.wav/.test(out), 'the filename stays on the meta line (plumbing, still visible)');
ok(/href="\/voices\/Narrator_2\.wav\/audio\?download=1"/.test(out), 'each row has a download link');
// 🔴 NO per-row <audio>. One player per row meant one media request per voice the moment the
// tab opened; with 26 voices that saturated Chrome's ~6-connections-per-host budget and the row
// you pressed ▶ on sat queued behind preloads for voices you never asked to hear — it would not
// start until a scrub-bar click tore the request down. The tab must cost ZERO audio requests
// until you ask for one, so a row carries a ▶ button and nothing else.
ok(!/<audio/.test(out), '🔴 a row renders NO <audio> element — the tab must issue no media request until you press ▶');
ok(!/preload=/.test(out), '🔴 and nothing preloads: that was the whole bug');
ok(/data-vplay="Narrator_2\.wav"/.test(out), 'each row has a ▶ button that opens the shared player');
ok(/class="sm ok" data-vplay=/.test(out), 'the ▶ is the green `ok` button at plain sm size — the same size as the ★ beside it');
// Keep the playback action between the favorite and download controls.
ok(
  /data-vfav="Narrator_2\.wav"[\s\S]*?data-vplay="Narrator_2\.wav"[\s\S]*?audio\?download=1/.test(out),
  '🔴 ▶ sits between the favorite star and the download link',
);

sandbox.vcTab = 'create';
sandbox.renderVoiceList();
out = el('vList').innerHTML;
ok(el('vListTitle').textContent === 'Created voices', 'the Create tab heading reads "Created voices"');
ok(/— 1 voice$/.test(el('vTotals').textContent.trim()), 'and counts only the created one');
ok(
  out.includes('Test_Voice_1.wav') && !out.includes('Test_Voice_2.mp3'),
  '🔴 the Create tab shows only created voices, not uploads',
);

sandbox.state.vlist = [{ name: 'x.wav', size: 1, label: '', origin: 'uploaded' }];
sandbox.vcTab = 'create';
sandbox.renderVoiceList();
ok(/No created voices yet/.test(el('vList').innerHTML), 'an empty Create tab says so in its own words, not "No voices."');

// A voice with NO origin field (a hand-dropped file the server saw without a sidecar) must
// land under Uploaded rather than vanishing from both tabs.
sandbox.state.vlist = [{ name: 'handmade.wav', size: 1, label: '' }];
sandbox.vcTab = 'upload';
sandbox.renderVoiceList();
ok(
  el('vList').innerHTML.includes('handmade.wav'),
  '🔴 a voice with no origin at all still appears, under Uploaded (no sidecar ⇒ uploaded)',
);

// ── 2b. 8.9 virtual folders: one open at a time, opened IN PLACE ─────────────
//
// Driven through the REAL `folderRows`/`folderBar` (see the prelude). The children must appear
// immediately below their folder, before the remaining folders. That ORDER is the whole
// interaction, and it is the thing a flat-array implementation gets wrong first.
sandbox.VFOLDERS = [
  { id: 'f_00000001', name: 'Auditions' },
  { id: 'f_00000002', name: 'Sample Folder' },
];
sandbox.VOPEN = '';
sandbox.state.vlist = [
  { name: 'aud1.wav', size: 1, label: 'Aud One', origin: 'uploaded', folder: 'f_00000001' },
  { name: 'keep1.wav', size: 1, label: 'Keep One', origin: 'uploaded', folder: 'f_00000002' },
  { name: 'loose1.wav', size: 1, label: 'Loose One', origin: 'uploaded' },
];
sandbox.vcTab = 'upload';
sandbox.FILT = {};
sandbox.renderVoiceList();
out = el('vList').innerHTML;
ok(/data-folder="f_00000001"/.test(out) && /data-folder="f_00000002"/.test(out), 'both folder rows render');
ok(out.indexOf('data-folder="f_00000001"') < out.indexOf('data-folder="f_00000002"'), 'folders come out in NAME order');
ok(
  out.indexOf('data-folder="f_00000002"') < out.indexOf('loose1.wav'),
  '🔴 every folder row sits ABOVE the unfiled rows — folders first, like Explorer',
);
ok(!out.includes('aud1.wav') && !out.includes('keep1.wav'), 'a CLOSED folder shows none of its children');
ok(out.includes('loose1.wav'), 'and the unfiled voice is still listed');
ok(/\(1\)/.test(out), 'a folder row carries its count');

sandbox.VOPEN = 'f_00000001';
sandbox.renderVoiceList();
out = el('vList').innerHTML;
ok(out.includes('aud1.wav'), 'opening a folder reveals its children');
ok(!out.includes('keep1.wav'), '…and only ITS children — one open folder at a time');
// 🔴 THE ORDERING CLAIM, and it is the reason this is a loop rather than three concatenated
// slices: the open folder's children sit between IT and the NEXT folder row, not after all of
// them and not at the top of the list.
ok(
  out.indexOf('data-folder="f_00000001"') < out.indexOf('aud1.wav') && out.indexOf('aud1.wav') < out.indexOf('data-folder="f_00000002"'),
  '🔴 the children open IN PLACE — directly under their own folder, ABOVE the folders that follow it',
);
ok(out.indexOf('data-folder="f_00000002"') < out.indexOf('loose1.wav'), 'and the later folder still precedes the unfiled rows');

// 🔴 A FILTER SEARCHES THE WHOLE SCOPE AND FLATTENS. A scoped search that answered "Nothing
// matches" while the voice sat in a CLOSED folder would be indistinguishable from the voice not
// existing — so typing collapses the folders and tags each hit with where it came from.
sandbox.VOPEN = '';
sandbox.FILT = { vFilter: 'keep' };
sandbox.renderVoiceList();
out = el('vList').innerHTML;
ok(out.includes('keep1.wav'), '🔴 a filter finds a voice inside a CLOSED folder');
// 🔴 THE FOLDER ROWS SURVIVE A FILTER, AS DESTINATIONS. Flattening them away entirely was the
// first cut and it broke the workflow folders exist for — search for the six you want, tick them,
// file them. With nothing to press that ends in "clear the filter and find them again".
ok(/data-folder="f_00000002"/.test(out), '…and the folder rows STAY, so a search result can be filed');
ok(!/data-fact="open"/.test(out), '…but they are not openable while flattened — no caret, no click');
ok(/data-fact="move"/.test(out), '…while ⇥ Move selected here is still there, which is the point of keeping them');
ok(/vftag/.test(out) && out.includes('Sample Folder'), '…and the hit is tagged with the folder it came from');
sandbox.FILT = {};

// The tick column that feeds `⇥ Move selected here`.
sandbox.VFOLDERS = [];
sandbox.renderVoiceList();
ok(/class="vchk" value="loose1\.wav"/.test(el('vList').innerHTML), 'every row carries a tick box keyed by its FILENAME');
ok(!/data-folder=/.test(el('vList').innerHTML), 'a scope with no folders renders exactly the pre-8.9 flat list');

// ── 2c. 8.9 drag-to-file: which rows a drag actually carries ───────────────
//
// The real `dragRefs`, pulled in above. This is the whole decision the dragstart handler makes,
// and it lives in a function precisely so a test can reach it — an event handler cannot be.
// ⚠️ VIA `vm.runInContext`, NOT `sandbox.dragRefs`. A `const` in a VM context is a LEXICAL
// binding and never becomes a property of the sandbox object — which is why `renderVoiceList`
// (a function DECLARATION, var-scoped) is reachable as `sandbox.x` and this is not.
const dragRefsIn = (ref, sel) => vm.runInContext(`JSON.stringify(dragRefs(${JSON.stringify(ref)}, ${JSON.stringify(sel)}))`, sandbox);
ok(dragRefsIn('a.wav', []) === '["a.wav"]', 'dragging a row with nothing ticked carries just that row');
ok(
  dragRefsIn('a.wav', ['b.wav', 'c.wav']) === '["a.wav"]',
  '🔴 dragging an UNTICKED row carries only IT — never a tick set it is not part of, which would move rows the gesture never pointed at',
);
ok(dragRefsIn('b.wav', ['b.wav', 'c.wav']) === '["b.wav","c.wav"]', '🔴 dragging a TICKED row carries the whole tick set');
ok(dragRefsIn('b.wav', ['b.wav']) === '["b.wav"]', 'a one-row tick set is still the tick set');
// The markup half: rows must be draggable and carry their ref, or nothing above can fire.
sandbox.VFOLDERS = [{ id: 'f_00000001', name: 'Auditions' }];
sandbox.renderVoiceList();
out = el('vList').innerHTML;
ok(/data-vrow="loose1\.wav"/.test(out), 'every row carries its ref as data-vrow, which is what a drag reads');
ok(/draggable="true"/.test(out), '…and is draggable');
ok(/data-folder="f_00000001"/.test(out), 'the folder row carries data-folder, which is what a drop reads');
ok(/class="vfgap" data-folder=""/.test(out), '🔴 the divider is a drop target with an EMPTY data-folder — dropping there UNFILES');

// ── 3. renderCandidates: no radio, no name box, no overwrite — and, from 7.0-m7,
//       a durable append-only list with a checkbox, a real delete, and its size on disk ──────
// ↩ FROM `vcBin`, NOT FROM vcRenderCandHead (7.3-m4e). The recycle bin's three declarations sit
// immediately above it and every render path below now asks `vcLive()` what the list is, so a
// slice that started at vcRenderCandHead would throw ReferenceError the moment renderCandidates
// ran. Stubbing them in the sandbox instead would have stubbed the thing under test.
const rcSrc = stripModuleSyntax(sliceDef('const vcBin=', 'function promptVoiceName('));

sandbox.vc = { cands: [], busy: false, total: 0, sel: new Set(), show: 100 };
sandbox.vcN = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
vm.runInContext(rcSrc, sandbox);

sandbox.vc.cands = [
  {
    token: 'a'.repeat(32),
    seed: 12345,
    duration_s: 4.2,
    size: 300,
    created: 2,
    url: '/voices/design/audio/' + 'a'.repeat(32),
  },
  {
    token: 'b'.repeat(32),
    seed: 67890,
    duration_s: 3.9,
    size: 200,
    created: 1,
    url: '/voices/design/audio/' + 'b'.repeat(32),
  },
];
sandbox.vc.total = 500;
sandbox.renderCandidates();
const cands = el('vcCandidates').innerHTML;
ok(!/type="radio"/.test(cands), '🔴 there is no radio — the rows are independent, nothing is "chosen"');
ok(!/data-vcname=/.test(cands), '🔴 no per-row name box — you name it AFTER deciding you want it');
ok(
  /data-vcsave="a{32}"/.test(cands) && /data-vcsave="b{32}"/.test(cands),
  'each row has its own Save (both candidates are independently saveable)',
);
// 🔴 The INVERSE of the 4.8-m3 assertion this replaced. That one asserted the seed was GONE from
// the row because a candidate was transient and provenance was where it belonged. §18.4 puts it
// back for the opposite reason: the row is now durable, so a kept clip can be replayed later.
ok(/seed 12345/.test(cands) && /seed 67890/.test(cands), '🔴 the seed IS on the row now (§18.4 — a kept row must carry its seed forward)');
// ── the players have to LINE UP. Seed values vary in length, so the metadata box needs a fixed basis.
// A content-sized metadata box lets seed length shift each audio player; the fixed class prevents
// that layout drift.
// ⚠️ This is a regex-over-source spec with `document: undefined` — it can prove the RULE is
// applied and that nothing overrides it. It cannot measure pixels, so it is a guard against the
// fix being undone, not a rendering test.
ok(/<div class="vcmeta"/.test(cands), '🔴 the metadata box uses the fixed-width .vcmeta class — the players share a starting x');
ok(
  !/<div class="vcmeta"[^>]*style="[^"]*flex/.test(cands),
  '🔴 …and no inline flex on that box, which would outrank the class and go elastic again',
);
ok(/<div class="vcmeta" title="/.test(cands), 'the full metadata is on the title too, so an ellipsis can never eat the seed (§18.4)');
// ⚠️ These two read `html`, not `main`. `main` is the last <script> block — the JS — and the rule
// being asserted is in the stylesheet, which lives outside it. Against `main` they fail closed,
// which is the harmless direction, but they would be asserting nothing.
ok(/\.vcmeta[^{]*\{[^}]*flex:0 0 \d+px/.test(html), '.vcmeta pins a FIXED basis in px — not auto, which is the bug, and not a percentage');
ok(/\.row>\.vcmeta/.test(html), '🔴 …and the rule also carries `.row>.vcmeta`, or `.row>div{flex:1 1 150px}` outranks it');
ok(
  /data-vcsel="a{32}"/.test(cands) && /type="checkbox"/.test(cands),
  '🔴 every row has a checkbox for multi-select',
);
ok(/data-vcdel="a{32}"/.test(cands), 'each row has its own Delete');
ok(!/data-vcdiscard=/.test(cands), '🔴 ✕ Discard is GONE — with no TTL, hiding a row would leak the clip forever (§18.5)');
ok(/class="danger"[^>]*data-vcdel/.test(cands), 'Delete is red');
ok(/class="ok"[^>]*data-vcsave/.test(cands), 'Save is green');
ok(/id="vcRegen"/.test(cands), 'a re-draw is still offered below the rows');
ok(/ADDED to the list/.test(cands), '🔴 and it says the draw is ADDED — re-rolling no longer supersedes what came before');
// The size and non-expiring retention are visible so users can decide when to reclaim storage.
ok(/500 B on disk/.test(el('vcCandTotals').textContent), "🔴 the header shows the list's total size on disk");
ok(/only you delete it/.test(el('vcCandTotals').textContent), 'and says plainly that nothing here expires');
ok(el('vcDelSel').disabled === true, 'Delete selected is disabled with an empty selection');

// ── 3a-i. ↩ Undelete last — the one-slot recycle bin (7.3-m4e) ──────────────
// vc_undelete_browser_spec.mjs verifies the behavior with a real fetch; this file checks the
// button markup and source rules.
ok(
  /id="vcUndel"[^>]*disabled/.test(html) || /disabled[^>]*id="vcUndel"/.test(html),
  'the ↩ Undelete last button ships DISABLED — an empty bin is not a live control',
);
ok(
  /class="recover xs"[^>]*id="vcUndel"/.test(html),
  'and is the amber `recover` button at xs, matching Delete selected sizing',
);
ok(
  html.indexOf('id="vcCandMoreTop"') < html.indexOf('id="vcUndel"') && html.indexOf('id="vcUndel"') < html.indexOf('id="vcDelSel"'),
  'it sits between Show all and ✕ Delete selected, where he put it',
);
ok(
  /button\.recover\{[^}]*var\(--warn\)/.test(html) && !/button\.recover\{[^}]*var\(--err\)/.test(html),
  '…and `recover` is amber, not a second red button beside the red one',
);
ok(el('vcUndel').disabled === true, 'the header renders it disabled while the bin is empty');
// 🔴 §18.5 — THE BIN MUST NOT BECOME A PLACE ROWS GO TO DISAPPEAR. Hiding a candidate forever is
// the leak the old ✕ Discard was, wearing a friendly button; that is why `vcDropCandidate` is
// checked for below and why this deferral is only legitimate because every way out of the bin
// either restores the row or deletes the clip. Both exits are pinned here.
ok(
  textRe('const commit=vcBin.tokens;').test(candJs) && textRe('await vcCommitBin(commit)').test(candJs),
  '🔴 the NEXT delete commits the previous one — the bin holds one deletion, never a backlog',
);
ok(
  textRe("addEventListener('beforeunload'").test(candJs) && textRe('keepalive:true').test(candJs),
  '🔴 and leaving the page commits it too, so a deferred delete cannot outlive the tab',
);
ok(
  textRe('vcBin.tokens=vcBin.tokens.filter(t=>live.has(t))').test(candJs),
  'a clip the server no longer has drops out of the bin, rather than leaving Undelete enabled ' + 'over a row that could never come back',
);
ok(
  !/localStorage/.test(candJs),
  '🔴 the bin is never persisted — a recycle bin that survives a reload is a promise the server ' + 'side of this feature does not make',
);

sandbox.vc.sel.add('a'.repeat(32));
sandbox.vcRenderCandHead();
ok(el('vcDelSel').disabled === false && /\(1\)/.test(el('vcDelSel').textContent), 'ticking one row enables the mass-delete and counts it');
ok(el('vcSelAll').checked === false, 'select-all is unchecked while only some are selected');
sandbox.vc.sel.add('b'.repeat(32));
sandbox.vcRenderCandHead();
ok(el('vcSelAll').checked === true, 'and checked once every row is selected');
sandbox.vc.sel.clear();

// §18.4 — a few hundred rows is unwieldy, so only the newest `show` are in the DOM. The cap is
// on RENDERING and says so; a silently truncated list would read as "that is all there is"
// about a store nothing else ever empties.
sandbox.vc.show = 1;
sandbox.vc.page = 0;
sandbox.renderCandidates();
ok(
  /data-vcsave="a{32}"/.test(el('vcCandidates').innerHTML) && !/data-vcsave="b{32}"/.test(el('vcCandidates').innerHTML),
  'only the newest `show` rows render',
);

// ── 3a-iii. paging — fifty at a time, with real controls at the bottom (7.3-m4f) ──
// Driven at 120 rows, because the interesting behavior is all at the boundaries and a
// two-row fixture cannot reach any of them.
const many = Array.from({ length: 120 }, (_, i) => ({
  token: 'p' + String(i).padStart(31, '0'),
  seed: i,
  duration_s: 1,
  size: 10,
  created: 1000 - i,
  url: '/voices/design/audio/p' + i,
}));
const rowsOf = () => [...el('vcCandidates').innerHTML.matchAll(/data-vccard="([^"]+)"/g)].map(m => m[1]);
sandbox.vc.cands = many;
sandbox.vc.total = 1200;
sandbox.vc.show = 50;
sandbox.vc.page = 0;
sandbox.renderCandidates();
ok(rowsOf().length === 50, 'a page is FIFTY rows — "show me 50 voices at a time"');
ok(rowsOf()[0] === many[0].token, 'and page 1 starts at the newest, as the list always has');
ok(/Page 1 of 3/.test(el('vcCandMore').innerHTML), 'the footer says which page you are on and how many there are');
ok(
  /showing 1–50 of 120/.test(el('vcCandMore').innerHTML),
  '🔴 …and WHICH rows. "Showing the newest 50 of 120" is true from every page and tells you ' + 'nothing once a Next button exists',
);
// Disabled at the ends, never hidden: a control that vanishes takes the row of buttons with it and
// the one you want slides under the cursor between clicks.
ok(/id="vcPrev"[^>]*disabled/.test(el('vcCandMore').innerHTML), '‹ Previous is DISABLED on page 1');
ok(!/id="vcNext"[^>]*disabled/.test(el('vcCandMore').innerHTML), 'and Next › is live');
sandbox.vc.page = 1;
sandbox.renderCandidates();
ok(rowsOf()[0] === many[50].token && rowsOf().length === 50, 'page 2 is the next fifty');
ok(/showing 51–100 of 120/.test(el('vcCandMore').innerHTML), 'and says so');
ok(
  !/id="vcPrev"[^>]*disabled/.test(el('vcCandMore').innerHTML) && !/id="vcNext"[^>]*disabled/.test(el('vcCandMore').innerHTML),
  'both controls are live in the middle',
);
sandbox.vc.page = 2;
sandbox.renderCandidates();
ok(rowsOf().length === 20 && rowsOf()[0] === many[100].token, 'the last page is the remainder, not a padded fifty');
ok(/id="vcNext"[^>]*disabled/.test(el('vcCandMore').innerHTML), 'Next › is disabled on the last page');
// 🔴 THE CLAMP. Delete the last row of the last page and the page index is suddenly past the end —
// which renders as an empty list with a Previous button as the only clue about what happened.
sandbox.vc.page = 9;
sandbox.renderCandidates();
ok(
  sandbox.vc.page === 2 && rowsOf().length === 20,
  '🔴 a page index past the end CLAMPS to the last page, and the clamp is written back to vc.page ' +
    '— deleting the last row of the last page must not strand you on an empty one',
);
sandbox.vc.cands = many.slice(0, 60);
sandbox.renderCandidates();
ok(sandbox.vc.page === 1 && rowsOf().length === 10, 'and it re-clamps when the list shrinks under it');
sandbox.vc.cands = many;
// Show all is still both places (§17.4 — the one at the bottom could not be found under a hundred
// players), and now it toggles: a 120-row DOM needs a way back to fifty.
sandbox.vc.show = 1e9;
sandbox.vc.page = 0;
sandbox.renderCandidates();
ok(rowsOf().length === 120, 'Show all renders every row');
ok(
  /Showing all 120\./.test(el('vcCandMore').innerHTML) && /id="vcPaged"[^>]*>Show 50 per page</.test(el('vcCandMore').innerHTML),
  '🔴 …and offers the way BACK to fifty — a 120-row DOM with no way out is the §17.4 complaint ' + 'again, pointing the other way',
);
ok(
  /showing all 120/.test(el('vcCandMoreTop').innerHTML) && /Show 50 per page/.test(el('vcCandMoreTop').innerHTML),
  'the top line says the same thing, because that is where he actually is',
);
sandbox.vc.show = 50;
sandbox.vc.page = 0;
sandbox.renderCandidates();
ok(
  /showing 1–50 of 120/.test(el('vcCandMoreTop').innerHTML) && /Show all/.test(el('vcCandMoreTop').innerHTML),
  '🔴 and the TOP line carries the range and the Show all too — §17.4: the way out has to be ' + 'where he is, which is the top',
);

sandbox.vc.cands = [
  {
    token: 'a'.repeat(32),
    seed: 12345,
    duration_s: 4.2,
    size: 300,
    created: 2,
    url: '/voices/design/audio/' + 'a'.repeat(32),
  },
  {
    token: 'b'.repeat(32),
    seed: 67890,
    duration_s: 3.9,
    size: 200,
    created: 1,
    url: '/voices/design/audio/' + 'b'.repeat(32),
  },
];
sandbox.vc.total = 500;
sandbox.vc.show = 100;
sandbox.vc.page = 0;

sandbox.vc.cands = [];
sandbox.vc.total = 0;
sandbox.renderCandidates();
ok(el('vcCandidates').innerHTML === '', 'no candidates renders nothing at all');
ok(el('vcCandHead').style.display === 'none', 'and the selection bar hides with it');

// ── 3a-ii. a refresh must not cut off the clip he is auditioning ─────────────
// 🔴 A batch lands a round every 30–60 s, and every refresh assigns innerHTML, which destroys
// every <audio> element in the box. Reviewing WHILE a batch runs is the COMMON case for this
// feature, so an unconditional repaint would stop the playback about once a minute, exactly when
// he is listening. Structural rather than behavioral — a real check needs a DOM, which is
// voices_player_browser_spec.mjs territory — but enough that the guard cannot vanish unnoticed.
const loadSrc = sliceDef('async function loadCandidates(', 'function vcRenderCandHead(');
ok(/vcAnyPlaying\(\)/.test(loadSrc), '🔴 a refresh asks whether a clip is playing BEFORE it repaints the list');
ok(/insertAdjacentHTML\('afterbegin'/.test(loadSrc), 'and prepends only the genuinely new rows when one is');
const wireSrc = sliceDef('function vcWirePlayback(', 'function vcAnyPlaying(');
ok(
  textRe('if(a.dataset.wired)return;').test(wireSrc),
  'the playback wiring is idempotent, so re-running it over a prepended list cannot double-wire',
);
ok(
  textRe('const siblings=()=>').test(wireSrc),
  'the pause-the-others sweep resolves its targets AT EVENT TIME — a captured list would miss ' + 'rows prepended after wiring',
);
ok(
  !/\.play\(/.test(wireSrc),
  '🔴 nothing in the candidate list starts playback by itself — playback starts only after the user clicks Play. ' +
    'Auto-advance previously started clips automatically when a live ' +
    'batch was prepending rows.',
);

// ── 3b-bis. §20.1 — the retry, and what happens when the retry does not work ─
// §20.1 shipped the self-heal and specified "only if that also fails, say so on the row". The
// second half was never built, so a permanently dead player stayed silent and looked merely
// disabled — which is the exact misreading that made the original bug take two sessions to
// become a report at all.
ok(
  textRe('const code=(a.error&&a.error.code)||0;').test(wireSrc),
  '🔴 the failure code is read BEFORE the retry — a.load() clears it, so reading it after ' + 'diagnoses the retry instead of the failure',
);
ok(
  /split\('#'\)\[0\]\.split\('\?'\)\[0\]/.test(wireSrc),
  'and the retry query is stripped, so the probe reports the clip URL and not a cache-buster',
);
// The ` *` this used to carry was already reaching for elasticity between `{` and the call; the
// brace is on its own line now, so it needs `\s*` — same two tokens, still adjacent, still the
// FIRST statement of the retried branch.
ok(
  textRe('if(a.dataset.retried){vcClipDead(').test(wireSrc),
  '🔴 a SECOND failure reports instead of retrying — one retry, never a loop against a clip ' + 'that is genuinely gone',
);

// The greps pin the shape; this runs the reporter, because the property that matters is
// behavioral — the row must end up SAYING something, and saying a different thing when the
// server still has the clip than when it does not.
const deadSrc = stripModuleSyntax(sliceDef('function vcClipDead(', 'function vcWirePlayback('));
ok(textRe("method:'HEAD'").test(deadSrc), 'it probes with HEAD — a GET would re-download the whole clip just to ask whether it is there');
ok(
  !/preload="metadata"/.test(deadSrc + wireSrc),
  '🔴 and nothing "fixes" this with preload="metadata", which only papers a failed load with a ' +
    'nicer-looking control and costs a request per row (§20.1)',
);

const runDead = async probe => {
  let text = '';
  const node = {
    setAttribute() {},
    style: {},
    className: '',
    set textContent(v) {
      text = v;
    },
    get textContent() {
      return text;
    },
  };
  const card = {
    _n: null,
    querySelector: () => card._n,
    appendChild(n) {
      card._n = n;
    },
  };
  const ctx = vm.createContext({
    document: { createElement: () => node },
    console: { warn() {} },
    fetch: () => probe,
    a: { dataset: { vcaudio: 'a'.repeat(32) }, closest: () => card },
    code: 4,
    base: '/voices/design/audio/' + 'a'.repeat(32),
  });
  vm.runInContext(deadSrc + '\nvcClipDead(a, code, base);', ctx);
  await probe.catch(() => {}); // let the probe settle…
  await new Promise(r => setTimeout(r, 0)); // …then let its .then/.catch run
  return text;
};

const stillThere = await runDead(Promise.resolve({ ok: true, status: 200 }));
ok(
  /would not play/.test(stillThere) && /still has it/.test(stillThere) && /200/.test(stillThere),
  '🔴 a dead player SAYS it is dead, and says the server still has the clip — silence is what ' +
    'made this look like a row that had simply not loaded yet',
);
ok(/reload the page/i.test(stillThere), 'and identifies reloading as the recovery step');
const gone = await runDead(Promise.resolve({ ok: false, status: 404 }));
ok(/404/.test(gone) && /not there any more/.test(gone), 'a clip the server no longer has is reported as GONE, not as a player problem');
ok(/deleting this row is safe/i.test(gone), 'and says what to do about it, because the row is now the only thing left of the clip');
const unreachable = await runDead(Promise.reject(new Error('offline')));
ok(/could not be reached/.test(unreachable), 'and a probe that cannot reach the server at all says THAT, rather than blaming the clip');
ok(
  /the server did not send playable audio/.test(stillThere),
  'the MediaError code is turned into a sentence — code 4 is "not playable audio", which with a ' +
    '200 is the single most diagnostic pair §20.1 can still collect',
);

// ── 3c. voice-design templates (7.0-m7 §17) ─────────────────────────────────
// Templates save the description, sample text, and quality steps for reuse, with sorting by name
// or creation date.
ok(/id="vcTpl"/.test(html), 'the Create card has a template picker');
ok(
  html.indexOf('id="vcTpl"') < html.indexOf('id="vcPrompt"'),
  'it sits ABOVE the boxes it fills — picking one is the first thing you do, not the last',
);
ok(
  /id="vcTplSort"/.test(html) && /Newest first/.test(html),
  'and a sort control offering name or creation date',
);
ok(
  /id="vcTplFav"/.test(html) && /id="vcTplSave"/.test(html) && /id="vcTplUpdate"/.test(html) && /id="vcTplDel"/.test(html),
  'with favorite, save-as, update and delete beside it',
);
// 🔴 A template stores THREE fields. Language is represented by sample text, so templates are not
// language-specific. §17.1 listed a fourth field and it is struck.
const tplJs = stripModuleSyntax(sliceDef('let vcTpls=[', 'function vcSyncModel('));
// ⚠️ RE-ANCHORED AT 8.8-m9, NOT WIDENED. `VEl` lost its invented `.value`, so each box is now
// read through a JSDoc cast — and while `stripComments` blanks the comment, the CAST'S PARENS
// remain and `relaxSpace` relaxes whitespace only. The three literals below admit exactly those
// parens and nothing else: each field is still required, still in this object, and still assigned
// from ITS OWN box. Renaming a field, swapping two boxes, or dropping one still fails.
ok(
  textRe("prompt:($('vcPrompt')).value").test(tplJs) &&
    textRe("sample_text:($('vcSample')).value").test(tplJs) &&
    textRe("steps:+(($('vcSteps')).value)").test(tplJs),
  'a save sends the description, the sample text and the quality steps',
);
ok(!/vcLang|vcLen/.test(tplJs), '🔴 and NOTHING about the language — the sample text already carries that (§17.4)');
// 🔴 The polarity of this one line is the whole of §17.3, and the design doc had it BACKWARD.
// vcApplyLang overwrites a box only while it still MATCHES vcFilled, so setting vcFilled to the
// template's own text is precisely what would license the next language change to discard it.
ok(
  textRe("vcFilled={prompt:'',sample:''}").test(tplJs),
  '🔴 loading a template CLEARS vcFilled, so a later language change cannot eat the restored text',
);
// 🔴 8.3.2 — THIS ONE STILL PASSED, WHICH IS WHY IT HAD TO BE FIXED. A negative check written
// against dense spacing goes on printing `ok` forever once the tree is respaced: there is no
// `vcFilled={prompt:t.` anywhere any more and there never will be again, so it was green over
// nothing and could not have caught the §17.3 regression it exists for. Both alternatives are kept
// verbatim — `t.` and the parenthesized `(t.` — one `textRe` each rather than one looser regex.
ok(
  !textRe('vcFilled={prompt:t.').test(tplJs) && !textRe('vcFilled={prompt:(t.').test(tplJs),
  "🔴 and does NOT set it to the template's values, which is the §17.3 trap",
);
// §17.4, answered from the code: Save always creates, editing is a separate verb by id.
ok(textRe("jpost('/voices/templates',{name").test(tplJs), 'Save posts a NEW template');
ok(/vcTplUpdate'\)\)?\.onclick/.test(tplJs), 'and Update is a separate control, by id');
// §17.4 — Save replaces the current template, while Save as creates another. Keeping these
// actions explicit avoids implying that form edits synchronize automatically.
ok(/Save into this template\?/.test(tplJs), 'Save-into-template confirms before replacing the template text');
ok(/id="vcTplUpdate"[^>]*>💾 Save</.test(html), '🔴 and the control is labeled Save, not Update');
ok(/id="vcTplSave"[^>]*>💾 Save as…</.test(html), 'with Save as… beside it for a NEW template — the pair every editor has');
ok(textRe('favorite:!t.favorite').test(tplJs), 'the star toggles rather than only setting');
ok(/\/use'/.test(tplJs) || /\/use/.test(tplJs), 'loading one counts as a use');

// ── 3b. the language picker (4.8-m4) ─────────────────────────────────────────
// VoxCPM2 has NO language parameter — its model card says "No language tag needed; input text
// in any supported language directly". So this control's whole job is swapping the sample text
// and the accent clause, and these assertions are what keep it honest.
ok(/id="vcLang"/.test(html), 'the Create card has a language preset picker');
ok(html.indexOf('id="vcLang"') < html.indexOf('id="vcPrompt"'), 'it sits at the top of the card, above the description');
// 🔴 It is "Sample text language", never bare "Language". Called "Language" the
// control over-promises: it sets no engine parameter, and pasting your own English text under a
// Spanish selection yields English. The NAME is the thing that stops it lying.
ok(
  /<label for="vcLang"[^>]*>Sample text language<\/label>/.test(html),
  'it is labeled "Sample text language" — not bare "Language", which would over-promise',
);
const langTip = (html.match(/<select id="vcLang"[\s\S]*?title="([^"]*)"/) || [])[1] || '';
ok(/PRESET, not a setting/i.test(langTip), 'the tooltip leads with "a PRESET, not a setting"');
ok(
  /NOT required to generate speech in any language/i.test(langTip),
  'the tooltip says outright that it is NOT required to generate any language',
);
ok(/TEXT is what determines the language/i.test(langTip), 'and that the text is what actually determines the language');

const langSrc = stripModuleSyntax(sliceDef('const VC_DESC=', 'let vcFilled='));
// Each row is ['Name','accent clause',[part1, part2, part3]] — the three CUMULATIVE parts the
// length picker joins (4.8-m4d). One string per line; Prettier broke the tuple across lines at
// 8.3.2, so the row is now `[\n  'Name',\n  'accent',\n  [\n    …parts…\n  ],\n]` at two-space
// nesting instead of one dense line, and the parts sit at six spaces rather than four.
//
// ⚠️ THE QUOTE CHARACTER IS NOW EITHER, AND THAT IS NOT A WIDENING. Prettier's `singleQuote`
// rewrote every part that contains no apostrophe to `'…'`, leaving the English ones (`It's`) on
// `"…"`; pinning `"` matched 30 rows' worth of nothing in most languages, which reads as "the
// samples were deleted". The delimiter is captured and back-referenced, so a row still has to be
// a properly closed single-line literal, and every claim built on the captured TEXT below —
// byte-equality with the markup default, the ≥40-character floor, strict growth, the English-dupe
// sweep, the pinned word counts — is unchanged and still does the real work.
const entries = [...langSrc.matchAll(/\n {2}\[\n {4}'([^']+)',\n {4}'([^']+)',\n {4}\[\n([\s\S]*?)\n {4}\],\n {2}\],/g)].map(m => [
  m[1],
  m[2],
  [...m[3].matchAll(/^ {6}(['"])(.*?)\1,?$/gm)].map(x => x[2]),
]);
ok(entries.length === 30, `all 30 languages the model card lists are present (found ${entries.length})`);
ok(entries[0][0] === 'English', 'English is first, and therefore the default');
// The model card's list, verbatim.
const CARD = [
  'Arabic',
  'Burmese',
  'Chinese',
  'Danish',
  'Dutch',
  'English',
  'Finnish',
  'French',
  'German',
  'Greek',
  'Hebrew',
  'Hindi',
  'Indonesian',
  'Italian',
  'Japanese',
  'Khmer',
  'Korean',
  'Lao',
  'Malay',
  'Norwegian',
  'Polish',
  'Portuguese',
  'Russian',
  'Spanish',
  'Swahili',
  'Swedish',
  'Tagalog',
  'Thai',
  'Turkish',
  'Vietnamese',
];
const got = entries.map(e => e[0]).sort();
ok(
  JSON.stringify(got) === JSON.stringify([...CARD].sort()),
  'the list matches the VoxCPM2 model card exactly — no invented or missing languages',
);

// 🔴 English must reproduce the tuned default byte-for-byte. That description and sample are
// what m0's ear-tests settled on; a language picker is not a license to re-tune them.
const promptDefault = (html.match(/<textarea id="vcPrompt"[^>]*>([\s\S]*?)<\/textarea>/) || [])[1];
const sampleDefault = (html.match(/<textarea id="vcSample"[^>]*>([\s\S]*?)<\/textarea>/) || [])[1];
ok(
  /a 20-year-old woman with a Midwestern American accent, warm and clear, studio-quality recording, close to the microphone/.test(
    promptDefault || '',
  ),
  "the markup's English description is still the tuned default",
);
ok(entries[0][1] === 'a Midwestern American accent', "and English's accent clause rebuilds exactly that string");
ok(/Oh, hi! It's so good to see you\./.test(sampleDefault || ''), "the markup's English sample is still the tuned default");
ok(langSrc.includes("Oh, hi! It's so good to see you."), "and English's table entry carries that same sample");
// 🔴 The markup default and English's 10 s part must be the SAME STRING. vcInitLang seeds
// vcFilled straight from the textarea, so if these ever drift apart an untouched box stops
// counting as "ours" and the very first language switch silently refuses to fill it in.
ok(
  (sampleDefault || '') === (entries[0][2] || [])[0],
  "the markup's sample is byte-for-byte English's 10 s part — vcFilled is seeded from it",
);

// Every entry must actually carry a sample in its own script — an empty or copy-pasted-English
// row would silently hand the user an English voice under a Spanish label.
const dupes = new Set();
let allHaveOwnSample = true;
for (const [name, , parts] of entries) {
  if (parts.length !== 3) {
    allHaveOwnSample = false;
    continue;
  }
  if (parts.some(p => !p || p.length < 40)) allHaveOwnSample = false;
  if (name !== 'English' && parts.join(' ').includes("It's so good to see you")) dupes.add(name);
}
ok(allHaveOwnSample, 'every language carries three non-trivial sample parts of its own');
ok(dupes.size === 0, `no language silently reuses the English sample (${[...dupes].join(', ') || 'none'})`);

// ── 3c. the length picker (4.8-m4d) ──────────────────────────────────────────
// Second half of the same preset: language picks WHICH passage, length picks HOW MUCH of it.
// Like the language box it sets no engine parameter — VoxCPM2 has none — so the same honesty
// rules apply, plus one of its own: 60 s is PAST the length the 07-17 ear test rejected, and
// the note has to say so rather than presenting three equal choices.
ok(/id="vcLen"/.test(html), 'the Create card has a sample-length picker');
ok(html.indexOf('id="vcLang"') < html.indexOf('id="vcLen"'), 'it sits to the RIGHT of the language picker');
ok(
  /<label for="vcLen"[^>]*>Approximate length<\/label>/.test(html),
  'it is labeled "Approximate length" — the approximation is stated in the label, not hidden',
);
const lenTip = (html.match(/<select id="vcLen"[\s\S]*?title="([^"]*)"/) || [])[1] || '';
ok(/PRESET, not a setting/i.test(lenTip), 'its tooltip leads with "a PRESET, not a setting" too');
ok(/APPROXIMATE/.test(lenTip) && /pace varies/i.test(lenTip), 'and says outright that the seconds are approximate because the pace varies');
ok(/never overwritten/i.test(lenTip), 'and that text you typed yourself is never overwritten');

// `[\s\S]*?` rather than `.*?`: the table is one row per line since 8.3.2 and `.` stops at the
// newline. Still non-greedy to the FIRST `];`, which is still this array's own close — an inner row
// ends `],` — so the slice is the same three rows it always was, and the pair regex below still
// requires a quoted label beside a single digit.
const lensSrc = (anywhere.match(/const VC_LENS\s*=\s*\[[\s\S]*?\];/) || [''])[0];
const lens = [...lensSrc.matchAll(/\[\s*'([^']+)'\s*,\s*(\d)\s*\]/g)].map(m => [m[1], +m[2]]);
ok(
  JSON.stringify(lens) ===
    JSON.stringify([
      ['10 s', 1],
      ['30 s', 2],
      ['60 s', 3],
    ]),
  'the three lengths are 10 / 30 / 60 s, mapping to 1 / 2 / 3 cumulative parts',
);
ok(
  textRe('wantLen=1').test(anywhere) && textRe('if(!VC_LENS.some(l=>l[1]===wantLen))wantLen=1').test(anywhere),
  '10 s is the default, and a stored value that is not one of the three falls back to it',
);
ok(/UIS\.setItem\('vocalis-vc-len'/.test(anywhere), 'the length choice is remembered too');

// Longer must actually BE longer — a copy-paste slip that repeated part 1 would leave "60 s"
// generating a 10 s clip while the note promised drift.
let growsWithLength = true;
for (const [, , parts] of entries) {
  const cum = [parts[0], parts.slice(0, 2).join(''), parts.join('')].map(s => s.length);
  if (!(cum[0] < cum[1] && cum[1] < cum[2])) growsWithLength = false;
}
ok(growsWithLength, 'in every language each length is strictly longer than the one below it');

// These reference timings come from a fixed VoxCPM2 v2.0.0 sample (cfg 2.0, 30 steps, seed 7, §4.1):
//     36 w -> 10.40 s   105 w -> 23.36 s   202 w -> 48.96 s
// which is where the first cut's 3.3 words/s died: the rate is NOT constant. A short passage
// carries proportionally more silence and pause, so it runs ~3.5 w/s while the long ones run
// ~4.1–4.5 — and a flat rate therefore left "30 s" and "60 s" 20% short of their own labels.
// Parts 2 and 3 were extended to the targets below and re-timed. Re-sizing these means timing
// them again; do not re-derive them from a words-per-second number.
const wc = s => s.split(/\s+/).filter(Boolean).length;
const enParts = entries[0][2];
const enCum = [wc(enParts[0]), wc(enParts[0]) + wc(enParts[1]), wc(enParts[0]) + wc(enParts[1]) + wc(enParts[2])];
const TARGETS = [36, 135, 250]; // words that measured 10 / 30 / 60 s on the run above
const inRange = (n, target) => n >= target * 0.9 && n <= target * 1.1;
ok(
  enCum.every((n, i) => inRange(n, TARGETS[i])),
  `the English passages match the timed word counts ${TARGETS.join(' / ')} (${enCum.join(' / ')})`,
);

ok(/id="vcLenNote"/.test(html), 'the note under the Sample text box has a per-length half');
// 🔴 The static half states the tradeoff (Chatterbox wants long / VoxCPM2 drifts long). Folding
// it into the per-length line would leave the verdict with nothing to be a verdict ABOUT.
ok(
  /10 s is the floor, around 60 s is ideal/.test(html) && /by about 36 s clips pick up echo/.test(html),
  'and still states BOTH halves of the tradeoff above it (4.8-m4c — do not simplify)',
);
const lenNote = sliceText('const VC_LENNOTE=', '// What the boxes held');
ok(/1:/.test(lenNote) && /2:/.test(lenNote) && /3:/.test(lenNote), 'all three lengths have a note');
ok(/<b>past<\/b> the ~36 s/.test(lenNote), 'the 60 s note says plainly that it is PAST the length that measured bad — it is not softened');
ok(/safe choice/.test(lenNote), 'and the 10 s note says it is the safe one');

// The user's own words are never destroyed by reaching for a dropdown.
const applySrc = sliceDef('function vcApplyLang(', '(function vcInitLang(');
ok(
  textRe('p.value===vcFilled.prompt').test(applySrc) && textRe('s.value===vcFilled.sample').test(applySrc),
  'switching language leaves text the user typed alone (only replaces what we filled in)',
);
ok(/UIS\.setItem\('vocalis-vc-lang'/.test(applySrc), 'the choice is remembered');
// ...and when it declines to overwrite, it SAYS so — otherwise picking 60 s over your own text
// looks like a dead control.
ok(
  /Your own sample text is untouched/.test(applySrc),
  'and says so in the note when it leaves your text alone, instead of appearing to do nothing',
);

// Chinese and Japanese have no spaces between clauses; joining their parts with one would show
// a gap that belongs to no writing system.
// Both members stay rigid: `textRe` never relaxes the inside of a string literal, so this cannot
// come to match a set of `' Chinese'` — which is the whole reason the check names them at all.
ok(
  textRe("const VC_NOSPACE=new Set(['Chinese','Japanese'])").test(anywhere),
  'Chinese and Japanese parts join with nothing, not with a space',
);
ok(textRe("VC_NOSPACE.has(e[0])?'':' '").test(anywhere), 'and that set is what vcSampleFor consults');

// ── 3c-drive: the two pickers, actually run ──────────────────────────────────
// Greps above pin the SHAPE; this runs the real vcApplyLang/vcInitLang against stub elements,
// because the interesting failures are behavioral — a length that silently keeps the short
// text, a switch that eats what the user typed, a stored preference that does not come back.
const langJs = stripModuleSyntax(sliceDef('const VC_DESC=', 'function switchVTab('));
const mkEl = () => ({
  innerHTML: '',
  value: '',
  _on: {},
  addEventListener(ev, fn) {
    this._on[ev] = fn;
  },
});
const vcEl = {
  vcLang: mkEl(),
  vcLen: mkEl(),
  vcPrompt: mkEl(),
  vcSample: mkEl(),
  vcLenNote: mkEl(),
};
vcEl.vcPrompt.value = promptDefault;
vcEl.vcSample.value = sampleDefault;
const store = {};
// A fresh context per run — the block is top-level `const`, so re-running it in the same one is
// a redeclaration. Which is the point: each call is a page LOAD, reading the same store.
//
// UIS, not localStorage: 5.x keeps the browser's localStorage to theme + vol and puts account
// state (which includes these two pickers) server-side in ui_state.yaml. The stub only has to
// honor the same two-method shape — getItem returning null for an absent key is what
// vcInitLang's `|| 'English'` fallback leans on.
const loadPage = () => {
  const box = {
    $: id => vcEl[id],
    esc: s => String(s),
    UIS: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
  };
  vm.createContext(box);
  vm.runInContext(langJs, box);
};
let drove = true;
try {
  loadPage();
} catch (e) {
  drove = false;
  console.error('  ' + e.message);
}
ok(drove, 'the language + length block runs standalone against stub elements');

if (drove) {
  const en = entries[0][2],
    sp = entries.find(e => e[0] === 'Spanish')[2];
  const zh = entries.find(e => e[0] === 'Chinese')[2];
  const pick = (lang, len) => {
    if (lang !== null) {
      vcEl.vcLang.value = lang;
    }
    if (len !== null) {
      vcEl.vcLen.value = String(len);
    }
    (lang !== null ? vcEl.vcLang : vcEl.vcLen)._on.change();
  };
  ok(
    vcEl.vcSample.value === en[0] && vcEl.vcPrompt.value === promptDefault,
    'startup with nothing stored leaves the markup defaults exactly as they are',
  );
  ok(/safe choice/.test(vcEl.vcLenNote.innerHTML), 'and the note already describes 10 s');

  pick(null, 3);
  ok(vcEl.vcSample.value === en.join(' '), '60 s joins all three English parts, in order');
  pick(null, 2);
  ok(vcEl.vcSample.value === en.slice(0, 2).join(' '), '30 s drops back to the first two');
  ok(
    /past<\/b> the ~36 s/.test(vcEl.vcLenNote.innerHTML) === false && /~36 s/.test(vcEl.vcLenNote.innerHTML),
    'and the note follows the choice down again',
  );

  pick('Spanish', null);
  ok(vcEl.vcSample.value === sp.slice(0, 2).join(' '), 'switching language KEEPS the chosen length — Spanish at 30 s, not back at 10 s');
  ok(vcEl.vcPrompt.value.includes('a neutral Spanish accent'), 'and the description follows the language');
  pick('Chinese', 3);
  ok(vcEl.vcSample.value === zh.join(''), 'Chinese joins with nothing at all — no space that belongs to no writing system');

  // 🔴 The one rule both pickers share: your words are yours.
  vcEl.vcSample.value = 'I will type my own thing, thank you.';
  pick(null, 1);
  ok(vcEl.vcSample.value === 'I will type my own thing, thank you.', 'a sample the user typed survives a length change');
  ok(/Your own sample text is untouched/.test(vcEl.vcLenNote.innerHTML), 'and the note says why, rather than the control looking dead');
  pick('German', null);
  ok(vcEl.vcSample.value === 'I will type my own thing, thank you.', 'and survives a language change too');

  ok(store['vocalis-vc-lang'] === 'German' && store['vocalis-vc-len'] === '1', 'both choices are written to the UI-state store');
  // Re-run from a fresh set of elements holding the shipped markup defaults: the stored pair
  // must come BACK, which is the whole point of storing them.
  for (const k of Object.keys(vcEl)) vcEl[k] = mkEl();
  vcEl.vcPrompt.value = promptDefault;
  vcEl.vcSample.value = sampleDefault;
  store['vocalis-vc-lang'] = 'Spanish';
  store['vocalis-vc-len'] = '3';
  loadPage();
  ok(vcEl.vcLang.value === 'Spanish' && vcEl.vcLen.value === '3', 'a reload restores both dropdowns from what was stored');
  ok(vcEl.vcSample.value === sp.join(' '), 'and refills the box with Spanish at 60 s');
  ok(/past<\/b> the ~36 s/.test(vcEl.vcLenNote.innerHTML), 'and warns about drift on arrival, not only after a click');
}

// ── 3d. the candidate count is spoken as a DIGIT, and follows the free cards ──
// It used to say "two voices" for any n>1 — a lie on a four-card box — and "a voice" for one.
// Show the actual candidate count in digits.
// ⚠️ END-ANCHORED ON THE BATCH BUTTON, NOT ON renderCandidates (7.3-m4b). It used to run to
// `function renderCandidates(`, which is in js/voice/candidates.js now — so with the module
// appended to `main` this slice would have run from the Generate handler through the whole
// remaining half of the inline block and on into the module. `$('vcBatchBtn').onclick` is the next
// top-level statement in the page after the queue's pointer comment, so the slice is once again
// "the Generate handler" and nothing else.
// ⚠️ RE-ANCHORED AGAIN AT 7.3-m4i, and for the same reason as last time: the end marker
// followed the code out of the page. `$('vcBatchBtn').onclick` is in js/voice/batch.js now, so
// against the appended halves this slice would have run from the Generate handler through the
// whole rest of the inline block AND all of candidates.js to get to it. `loadBooks` is the next
// definition in the PAGE after the two pointer comments the extractions left behind.
//
// 🔴 RE-ANCHORED A THIRD TIME AT 7.3-m6b — AND THIS TIME ON SOMETHING THAT CANNOT DRIFT AGAIN.
// `loadBooks` moved to js/book/books.js, so that marker was about to become the third end anchor
// in a row to walk out of the page. Chasing "whatever definition happens to be next" is the bug:
// the neighbor belongs to another feature, so it leaves on somebody else's schedule and takes
// this slice's meaning with it, silently — the old `main.indexOf` form answers -1 and `main.slice
// (from, -1)` is the whole rest of the block minus one character, which still PASSES the positive
// check below and can only fail the negative one, for a reason that names nothing.
//
// The end anchor is now the QUEUE POINTER COMMENT, which is Create-a-voice's own text sitting
// directly under the Generate handler. It moves when this area moves, i.e. on the same event as
// the start marker — so the two travel together instead of one chasing the other. When m8 takes
// the Create tab, `sliceDef`/`sliceText` follow both into the module and the slice still means
// "the Generate handler"; when the pointer is finally deleted with the inline block at m13,
// `sliceText` throws with the marker named instead of returning garbage.
// ✅ AND THAT IS EXACTLY WHAT HAPPENED, AT 7.3-m13, WITH THE PREDICTED FAILURE. The pointer
// comment lived in index.html's inline block, m13 deleted that block outright, and `sliceText`
// threw `MarkerNotFound: end text marker not found` naming the string and listing all 65 files it
// searched — rather than returning a garbage slice that the negative checks below would have
// passed. 📌 The note above earned its place: the loud failure is the whole reason to prefer a
// marker that throws over an index arithmetic that silently returns the wrong range.
//
// 🔴 THERE IS NO END ANCHOR ANY MORE, BECAUSE THERE IS NOTHING AFTER IT. The Generate handler is
// the LAST construct in js/voices/voices.js, so every candidate end marker — the next definition,
// the next comment — does not exist. Slicing to end-of-file is the honest expression of "the
// Generate handler and what follows it", and it cannot go stale the way both previous anchors did:
// the first chased a moving definition, the second was prose that m13 deleted.
//
// ⚠️ `sourceOf` PICKS THE FILE BY THE SIGNATURE, so this still follows the code if the Create tab
// moves again — the same property `sliceText` was chosen for. What is lost is the END bound, and
// nothing after the handler means nothing to be wrong about.
// ⚠️ BOTH HALVES NEEDED THE CAST'S PAREN — the locate AND the split. Splitting on a needle that
// is no longer present returns the WHOLE source as a single element, so `.pop()` would have handed
// the next assertions the entire file rather than the handler. Silent, not red.
// ⚠️ BOTH HALVES NEEDED THE CAST'S PAREN — the locate AND the split. Splitting on a needle that
// is absent returns the WHOLE source as one element, so `.pop()` would hand every assertion below
// the entire file instead of the handler: silent, not red.
// ⚠️ THE FILE IS LOCATED BY A DEFINITION, THE HANDLER BY TEXT. `sourceOf` anchors at column 0 and
// the wiring line now begins with m10's cast comment, so it can no longer name its own file —
// `const vOrder=list=>` is a column-0 definition in the SAME file and is what §14.7 already slices
// on at :222. The split then takes the cast form.
//
// 🔴 BOTH HALVES MATTER. Splitting on a needle that is absent returns the whole source as ONE
// element, so `.pop()` would hand every assertion below the entire file instead of the handler —
// green, and measuring nothing.
const genSrc = sourceOf('const vOrder=list=>').split("($('vcGenBtn')).onclick").pop();
ok(genSrc.length > 0 && genSrc.length < 8000, 'located the Generate handler in js/voices/voices.js');
ok(textRe('function vcN(n,noun)').test(anywhere), 'there is one pluralizing helper for the counts');
// The three literals — `' '`, `''`, `'s'` — are still matched byte-for-byte; only the operator
// spacing around them moved. A digit-plus-noun claim that tolerated `'s '` would be worthless.
ok(
  textRe("return n+' '+noun+(n===1?'':'s')").test(anywhere),
  'it emits a DIGIT plus the noun ("1 voice" / "2 voices"), never a spelled-out word',
);
// 🔴 NOT `textRe` — this marker starts INSIDE the string literal (`… Designing ' +`) and ends
// outside it, so relaxSpace would mis-pair the quotes and treat `'+vcN(j.n||1,'` as one rigid
// atom. Hand-relaxed instead, and the trailing space in `Designing ` is deliberately literal: it
// is part of the message, not layout.
ok(
  /Designing '\s*\+\s*vcN\(\s*j\.n\s*\|\|\s*1\s*,\s*'voice'\s*\)/.test(genSrc),
  'the "Designing…" line uses the server\'s own count, not a hardcoded two',
);
// Strip // comments first — the code carries a note explaining what the old hardcoded string
// was, and matching that would fail the check for describing the very bug it prevents.
const noComments = s =>
  s
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l))
    .join('\n');
const countPaths = noComments(genSrc + sliceDef('async function vcPoll(', 'function renderCandidates('));
ok(!/two voices|Two voices|'a voice'/.test(countPaths), '🔴 no hardcoded "two voices" / "a voice" survives in the generate or poll path');
ok(!/One candidate finished/.test(anywhere), 'the canceled line counts the candidates too, rather than assuming one');

// ── 4. the never-overwrite rule, as the UI honors it ────────────────────────
// One rule, no exceptions (§14.9.1): to replace a voice you delete it first. An "Overwrite?"
// modal anywhere in the voices JS means the rule grew a hole.
// ⚠️ TWO FILES SINCE 7.3-m4b. The banner pair still bounds the Voices + Create-a-voice code in the
// page, but the ✓ Save / ✕ Delete gestures the rules below are about are in js/voice/candidates.js.
// The block is the union, because "the voices UI" is what the never-overwrite rule is scoped to and
// that has not changed — only where the bytes sit. Left as the page slice alone, the four save-path
// checks would have gone looking in a file the code had left, and `promptVoiceName` would have
// matched the POINTER COMMENT that names it: a green check reading a forwarding address.
// 🔴 CONVERTED TO sliceText AT 7.3-m6b, AND THE CONVERSION IS THE FIX — not the new end marker.
// `// ── Book library` was a BANNER, and m6b cut that banner out of the page. `main.indexOf` then
// answered -1, `main.slice(from, -1)` ran from Voices management to one character short of the end
// of the inline block, and this slice quietly became "over half the front end". The precondition
// below sailed through — a slice that is far too LONG is still `.length > 1000` — and the only
// thing that reported it was the negative check two lines down, which went red naming an overwrite
// flag that belongs to some other feature entirely. That is a check failing for a true reason and
// describing a false one, which is worse than either.
//
// ⚠️ The end marker is the NEXT AREA's banner, so it will leave the page too, at m10. That is fine
// and is the whole point of the conversion: `sliceText` throws with the marker named and node exits
// 1 with a stack, instead of returning garbage that half the checks below can still pass against.
// A drifting anchor is a maintenance cost; a silent -1 is a deleted check.
//
// 📌 The `ok(voicesJs.length > 1000, …)` precondition is DROPPED, per _websrc.mjs's header: a bare
// sliceText IS the located-it check now, and — as above — the length assertion could not tell the
// two failure directions apart anyway.
// 🔴 The legacy end marker (`// ── Voice Studio (4.0): sub-tabs`) was a banner in `media/voiceswap.js`,
// which is not in this product; it sat in another file than the start marker, so `sliceText` ran
// to the end of voices.js. Omitting the end marker asks for exactly that, with no dependence on a
// file that is not here.
const voicesJs = sliceText('// ── Voices management', null) + '\n' + candJs;
ok(!/Overwrite\?/.test(voicesJs), '🔴 no "Overwrite?" prompt survives anywhere in the voices UI');
ok(!/overwrite:\s*true|append\('overwrite'/.test(voicesJs), '🔴 and nothing sends an overwrite flag');
ok(/That name is taken/.test(voicesJs), 'a collision is reported as a rejection instead');
// ⚠️ THE CALL, NOT THE NAME (7.3-m4b). A bare /promptVoiceName/ over this block now also matches
// the POINTER COMMENT left in index.html, which lists every function the module took with it — so
// the check would go on passing after the call site itself was deleted, reading a forwarding
// address and reporting it as a feature.
ok(textRe('=await promptVoiceName(').test(voicesJs), 'saving a candidate asks for the name in a modal');
// ── 4a. a saved candidate LEAVES the list, by being deleted (7.2-m5) ─────────
//
// A saved candidate should leave the list only after its clip is deleted. Hiding the row locally
// would leave generated audio unreachable; the checks below require the delete path.
//
// 🔴 SO THE CHECK IS NOT "DOES THE ROW GO" — IT IS "DOES ANYTHING HIDE ONE". Hiding is the leak;
// deleting is not. A future change that drops the row locally (splice out of `vc.cands`, a
// `display:none`, a `vcDropCandidate` helper) instead of calling `vcDelete` would look identical
// on screen and put the bytes beyond reach, which is precisely the regression 7.0-m7 was written
// to stop and precisely what this now permits if it is checked carelessly.
ok(!/vcDropCandidate/.test(anywhere), '🔴 nothing HIDES a candidate row — a row that leaves does so because its clip was deleted (§18.5)');
ok(textRe('await vcDelete([tok],false)').test(voicesJs), '🔴 saving deletes the candidate through the same vcDelete the ✕ button uses');
ok(/its clip is deleted/.test(voicesJs), 'and the success dialog says the clip is gone, rather than leaving him to notice');
// ⚠️ THE FAILURE BRANCH IS THE POINT OF `vcDelete` RETURNING ANYTHING. A save that succeeds and a
// delete that fails must not print "its clip is deleted" while the row is still present.
// ⚠️ THE SECOND HALF IS HAND-RELAXED, NOT `textRe`. The marker is the FALSE arm of a ternary and
// stops mid-sentence, so its `'` never closes; relaxSpace would fall back to treating the quote as
// an ordinary character and go on to make the SENTENCE's own spacing elastic, which for a string
// literal is a widening — `saved,but` would satisfy it. Only the gap between `:` and the quote is
// relaxed here; every byte the user reads stays pinned.
ok(
  textRe('const gone=await vcDelete').test(voicesJs) &&
    /:\s*'The voice was saved, but the candidate clip could not be deleted/.test(voicesJs),
  'a failed delete after a good save says so, instead of claiming the clip went',
);
ok(/return gone;/.test(voicesJs), '…which is what vcDelete reports back for');

// ── 4b. the rows are striped, so a list that shifts SAYS it shifted (7.2-m5) ──
//
// Alternating row backgrounds make positional changes visible when a candidate is removed.
ok(
  /#vcCandidates>\[data-vccard\]:nth-child\(even\)\{background:var\(--stripe\);?\}/.test(html),
  'the candidate rows alternate their background',
);
// 🔴 POSITIONAL, NOT BAKED INTO THE ROW. New candidates are PREPENDED (insertAdjacentHTML
// 'afterbegin'), so a shade written into vcRowHTML would be wrong for every row below the first
// the moment one arrived — and wrong in the exact situation the stripes exist to report.
ok(
  !/data-vccard="\$\{esc\(c\.token\)\}"[^>]*(odd|even|stripe)/.test(anywhere),
  'the shade is a CSS position, never a class chosen when the row is built',
);
// ⚠️ BOTH THEMES. `--panel` is #ffffff in the light theme, so a stripe defined only in `:root`
// would render as a near-black bar across every other row.
for (const theme of [/:root\{[\s\S]*?--stripe:#[0-9a-f]{6}/, /:root\[data-theme="light"\][\s\S]*?--stripe:#[0-9a-f]{6}/])
  ok(theme.test(html), `--stripe is defined for ${theme.source.includes('light') ? 'the light' : 'the dark'} theme`);

// ── 5. the Voices sub-tab survives a hard refresh (4.8-m4d) ──────────────────
// The top-level tab has been remembered since 4.1; the sub-tab under Voices was not, so a hard
// refresh while designing a voice previously returned to Upload.
ok(/UIS\.setItem\('vocalis-vtab'/.test(voicesJs), 'switchVTab remembers the sub-tab');
ok(/UIS\.getItem\('vocalis-vtab'\)/.test(voicesJs), 'and something reads it back on load');
// 🔴 It must be PARKED, not applied at script-eval time: the Create tab's button is hidden until
// /health confirms VoxCPM2 is installed, so restoring it early shows a panel with no way back.
ok(textRe('let vcTabWant=null').test(voicesJs), 'the restored wish is parked in vcTabWant');
// 🔴 THE STATEMENT ORDER IS THE CLAIM IN THE NEXT THREE, and it survives the respace intact: the
// braces and the `;` separators are still required and still in that sequence, so a version that
// read the wish without clearing it — or cleared it somewhere else — still fails. Prettier put each
// statement on its own line, which `\s*` covers; it did not reorder or drop one.
ok(
  textRe('if(vcTabWant){const w=vcTabWant;vcTabWant=null;').test(voicesJs),
  'and spent inside vcSyncModel, once availability is actually known',
);
ok(textRe('if(!avail){vcTabWant=null;').test(voicesJs), 'a missing venv drops the wish rather than restoring a tab that does not exist');
ok(textRe("switchVTab('upload',false)").test(voicesJs), "and that forced fallback does NOT overwrite the user's remembered choice");
ok(
  // ⚠️ THE RECEIVER IS MATCHED BY REGEX SINCE 8.8-m7; THE CLAIM IS UNCHANGED. m6 deleted the
  // global EventTarget widening, so this handler binds the clicked element once with a real
  // cast rather than lying about the listener's parameter type. Still pinned: the wish is
  // nulled and the tab switched to THAT element's own `dataset.vtab`, in that order.
  // 8.8.6: the receiver is the EXACT local again. m7's regex accepted any dotted path, so
  // `switchVTab(document.body.dataset.vtab)` would have matched and the claim - that the tab
  // switched to THAT element's own vtab - was gone. The source binds `const tab = (e.target)`,
  // so the exact text is available and an alternation is not needed.
  textRe('vcTabWant=null;switchVTab(tab.dataset.vtab)').test(voicesJs),
  'clicking a sub-tab cancels the pending restore, so /health cannot yank you off it',
);

// ── 6. favorites + sorting for the voice list (4.8-m5 §16) ───────────────────
ok(/id="vSort"/.test(html), 'the Voices tab has a sort control');
ok(
  /<option value="added">Recently added<\/option>\s*\n?\s*<option value="name">Name</.test(html),
  'Recently added is listed FIRST and is therefore the default',
);
ok(/UIS\.setItem\('vocalis-vsort'/.test(voicesJs), 'the sort choice is remembered');
ok(/UIS\.getItem\('vocalis-vsort'\)/.test(voicesJs), 'and read back on load');
// 🔴 ONE setting for both sub-tabs (§16.5) — switchVTab re-renders, it must not re-sort.
// 🔴 THE END OF THIS SLICE IS CHECKED, AND THAT MATTERS MORE HERE THAN ANYWHERE ELSE IN THE FILE.
// The assertion is NEGATIVE — "switchVTab does not assign vSort=" — so an end needle that is not
// found does not turn it red, it turns it MEANINGLESS: `slice(start, -1)` runs to end-of-file and
// the check is asserted over a span twenty times too large, still green. m10's cast put a `)`
// between `$('vTabs')` and `.addEventListener` and that is exactly what happened.
const svEnd = voicesJs.search(/\$\('vTabs'\)\)?\.addEventListener/);
ok(svEnd > 0, "located the vTabs wiring that ends switchVTab's slice");
// 🔴 AND THE START NEEDLE TOO - IT WAS THE ONE HALF LEFT UNGUARDED. `indexOf` returns -1 for a
// miss, and `slice(-1, svEnd)` does not throw either: it starts one character from the END of the
// file, so for any svEnd before that it yields '' and this NEGATIVE assertion passes over an empty
// string, green forever. Renaming switchVTab would have silently retired the check. The sibling
// slice below (loadVoices in devices.js) already guards both ends; this one guarded only one.
const svStart = voicesJs.indexOf('function switchVTab(');
ok(svStart > 0, 'located switchVTab, whose body this negative assertion is about');
ok(!/vSort=/.test(voicesJs.slice(svStart, svEnd)), '🔴 switching sub-tab does NOT change the order (one setting, two views of one store)');

// ★ round-trip through the real renderer.
sandbox.vcTab = 'upload';
sandbox.vSort = 'name';
sandbox.state.vlist = [
  {
    name: 'zz_test_voice_1.wav',
    size: 1,
    label: 'Test Voice 1',
    origin: 'uploaded',
    favorite: false,
    added: 300,
    added_exact: true,
  },
  {
    name: 'Aaa_test_voice_2.wav',
    size: 1,
    label: 'Test Voice 2',
    origin: 'uploaded',
    favorite: true,
    added: 100,
    added_exact: true,
  },
  {
    name: 'test_voice_3.wav',
    size: 1,
    label: 'Test Voice 3',
    origin: 'uploaded',
    favorite: false,
    added: 200,
    added_exact: false,
  },
];
sandbox.renderVoiceList();
out = el('vList').innerHTML;
ok(/data-vfav="zz_test_voice_1\.wav"/.test(out), 'every row carries a ★ button');
ok(/class="sm fav on"[^>]*data-vfav="Aaa_test_voice_2\.wav"/.test(out), "the favorite's star is the FILLED, gold one");
ok(/class="sm fav"[^>]*data-vfav="test_voice_3\.wav"/.test(out), 'an unfavorited one is the hollow star');
// Favorites float; within each half the chosen order holds.
const rowOrder = s => [...s.matchAll(/data-vfav="([^"]+)"/g)].map(m => m[1]);
ok(
  JSON.stringify(rowOrder(out)) === JSON.stringify(['Aaa_test_voice_2.wav', 'zz_test_voice_1.wav', 'test_voice_3.wav']),
  '🔴 sorted by NAME: the favorite floats, then Test Voice 1 before Test Voice 3 — by the LABEL the user ' +
    'sees, not the filename (zz_test_voice_1 sorts first, Aaa_test_voice_2 would sort first by filename) (§16.9a)',
);
sandbox.vSort = 'added';
sandbox.renderVoiceList();
ok(
  JSON.stringify(rowOrder(el('vList').innerHTML)) === JSON.stringify(['Aaa_test_voice_2.wav', 'zz_test_voice_1.wav', 'test_voice_3.wav']),
  'sorted by ADDED: the favorite still floats, then newest first (300 before 200)',
);
// 🔴 §16.7 — a star in a NAME is text, never a rank. This bug has shipped here once already.
sandbox.vSort = 'name';
sandbox.state.vlist = [
  { name: 'a.wav', size: 1, label: '★ Faux', origin: 'uploaded', favorite: false, added: 1 },
  { name: 'b.wav', size: 1, label: 'Real', origin: 'uploaded', favorite: true, added: 2 },
];
sandbox.renderVoiceList();
ok(
  rowOrder(el('vList').innerHTML)[0] === 'b.wav',
  '🔴 a voice merely NAMED "★ Faux" gets no special position — the flag beats the text (§16.7)',
);

// The add-date: sortable either way, but an inferred one is never asserted as fact (§16.3).
sandbox.state.vlist = [
  { name: 'known.wav', size: 1, label: 'Known', origin: 'uploaded', added: 300, added_exact: true },
  {
    name: 'guess.wav',
    size: 1,
    label: 'Guess',
    origin: 'uploaded',
    added: 200,
    added_exact: false,
  },
];
sandbox.renderVoiceList();
out = el('vList').innerHTML;
ok(/added D300/.test(out) && !/added ~D300/.test(out), 'a RECORDED add-date prints plainly');
ok(/added ~D200/.test(out), '🔴 an INFERRED one is marked with a tilde, not printed as fact');
ok(/title="Approximate[^"]*"[^>]*>added ~D200/.test(out), 'and says where the number came from');
sandbox.state.vlist = [{ name: 'n.wav', size: 1, label: 'N', origin: 'uploaded' }];
sandbox.renderVoiceList();
ok(!/added/.test(el('vList').innerHTML), 'no add-date at all renders nothing, not "added "');

// ── 7. the pickers: two alphabetical blocks, gold ⭐, value untouched (§16.9) ──
// 🔴 7.3-m4q: BOTH MARKERS MOVED TO js/ui/voicepicker.js, so `main.indexOf` answered -1 for each
// and `main.slice(-1, -1)` is '' — vm would have run nothing and `sandbox.voiceOptionsHTML` would
// have come back undefined. Sabotage-verified by putting the indexOf pair back: 215 ok, ZERO FAILs,
// then a TypeError at the first call and node dies — the remaining 21 checks never run and nothing
// on screen says a check was skipped rather than passed. That silence is §3.5's whole point.
// sliceDef
// follows them into the module and throws with the marker named if it ever cannot. The
// `ok(vohFrom > 0 …)` precondition is DROPPED rather than wrapped: sliceDef throwing IS the check,
// which _websrc.mjs's header says explicitly, and that is why this file's count falls by one.
vm.runInContext(stripModuleSyntax(sliceDef('function voiceOptionsHTML(', 'const voiceLabelOf=')), sandbox);

const picker = [
  { name: 'zz_test_voice_1.wav', label: 'Test Voice 1', favorite: false },
  { name: 'Aaa_test_voice_2.wav', label: 'Test Voice 2', favorite: false },
  { name: 'test_voice_3.wav', label: 'Test Voice 3', favorite: false },
  { name: 'wanda.wav', label: 'Wanda', favorite: true },
  { name: 'faux.wav', label: '★ Faux', favorite: false },
];
const opts = sandbox.voiceOptionsHTML(picker, '', '(none)');
const values = [...opts.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
const texts = [...opts.matchAll(/<option [^>]*>([^<]*)</g)].map(m => m[1]);
ok(values[0] === 'wanda.wav', '🔴 the favorite comes first, ahead of every unfavorited voice');
ok(!values.slice(1).some(v => picker.find(p => p.name === v)?.favorite), 'and no favorite is stranded below a non-favorite');
const rest = values.slice(1).filter(v => ['zz_test_voice_1.wav', 'test_voice_3.wav', 'Aaa_test_voice_2.wav'].includes(v));
// 🔴 EXPECTATION CORRECTED, NOT THE CODE (2026-10-08). `voiceOrder` sorts by `label || name`
// (voicepicker.js `voiceSortName`, §16.9a), so labels "Test Voice 1/2/3" can only come out as
// 1, 2, 3 = zz_test_voice_1, Aaa_test_voice_2, test_voice_3. This array was [zz_1, test_3, Aaa_2]
// because the generic-fixture cleanup (legacy c498e5e2) renamed the fixture's labels Aria/Mona/
// Zoe -> Test Voice 1/3/2 and mechanically carried the old ORDER over: with the original labels
// "Aria, Mona, Zoe" the same array [zz_aria, mona, Aaa_zoe] WAS alphabetical, and the rename
// (Mona -> 3, Zoe -> 2) silently made it not. The fixture still does its job: the filename order
// (Aaa_test_voice_2, test_voice_3, zz_test_voice_1) differs from the label order in EVERY
// position, so a regression to sorting by filename cannot pass.
ok(
  JSON.stringify(rest) === JSON.stringify(['zz_test_voice_1.wav', 'Aaa_test_voice_2.wav', 'test_voice_3.wav']),
  '🔴 the rest are alphabetical by DISPLAY NAME (Test Voice 1, 2, 3) — not by filename, which ' +
    'would have put Aaa_test_voice_2 first. A fixture where the two agree would pass for the wrong reason',
);
ok(values[0] !== 'faux.wav', '🔴 a "★" in the LABEL still buys no position in the picker (§16.7)');
// 🔴 §16.9c — the star is decoration. A ⭐ reaching a value would land in voice_settings.yaml.
ok(
  texts.some(t => /^⭐ Wanda$/.test(t)),
  "the favorite's option text carries a gold ⭐",
);
ok(texts.filter(t => t.includes('⭐')).length === 1, 'and EXACTLY the favorites carry one');
ok(!values.some(v => v.includes('⭐')), '🔴 no option VALUE contains the star — values stay bare filenames');
ok(
  JSON.stringify([...values].sort()) === JSON.stringify(picker.map(p => p.name).sort()),
  'every voice is still present, under its own unaltered filename',
);
// The other builder must go through the same helpers, or Book/Playground drift from the rest.
//
// 🔴 7.3-m4: loadVoices IS IN js/sys/devices.js NOW, and this slice used to straddle the move.
// It ran from `async function loadVoices()` to `const BOOK_F=` — and BOOK_F stayed inline (it is
// a top-level `const` the module reads through the scope chain), so after the extraction the two
// boundaries were in DIFFERENT FILES. `indexOf` returned -1 for the first, the slice came back
// as something meaningless, and the check went red. It could just as easily have come back
// non-empty and gone quietly green, which is the real hazard with a text slice.
//
// So both ends are anchored inside the module: loadVoices is the last definition in it, and the
// delegated wiring is the first thing after. `export ` is stripped for the reason kobold_ui_
// smoke.mjs records — an END needle landing on an exported declaration keeps the keyword.
const devPath = join(dirname(htmlPath), 'js', 'sys', 'devices.js');
const devjs = (await readFile(devPath, 'utf8')).replace(/\r\n/g, '\n').replace(/^export /gm, '');
// 🔴 THE END NEEDLE IS A REGEX AND ITS RESULT IS CHECKED, BECAUSE `indexOf` FAILS AS A PASS.
// m10's cast put a `)` between `$('devList')` and `.addEventListener`, so this returned -1 — and
// `slice(start, -1)` does not throw, it silently runs to the end of the file. All three assertions
// below went on passing against a region twenty times too large, green the whole time. A slice
// whose end cannot be found must be an ERROR, never a longer slice.
const lvEnd = devjs.search(/\$\('devList'\)\)?\.addEventListener\('change'/);
ok(lvEnd > 0, "located the devList change listener that ends loadVoices' slice");
const lvSrc = devjs.slice(devjs.indexOf('async function loadVoices()'), lvEnd);
ok(lvSrc.length > 0 && lvSrc.length < 4000, 'located loadVoices in js/sys/devices.js');
ok(
  /voiceOrder\(vs\)/.test(lvSrc) && /voiceOptText\(v\)/.test(lvSrc),
  '🔴 loadVoices (Book + Playground) uses the SAME order and star helper as every other tab',
);

// ── §20.4: the batch shows WHAT IT IS GENERATING, read-only ─────────────────
//
// 🔴 THE BATCH CARRIES ITS OWN COPY OF THE FORM. The top-level inputs can change while work is
// running, so the batch summary must show the values captured by that job. Driven as a pure
// function, so this asserts the rendering and not a live server.
{
  const bf = {
    esc: t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
  };
  vm.createContext(bf);
  vm.runInContext(stripModuleSyntax(sliceDef('function vcBatchForm', 'function vcRenderBatch')), bf);

  ok(
    bf.vcBatchForm(null) === '' && bf.vcBatchForm({ status: 'idle' }) === '',
    'no batch, no panel — it never sits there empty saying nothing',
  );

  const SAMPLE = 'Oh, you are teasing. Sit down, I will make you something warm to drink.';
  const running = bf.vcBatchForm({
    status: 'running',
    prompt: 'a wry older woman, close mic',
    sample_text: SAMPLE,
    steps: 24,
  });
  ok(running.includes('a wry older woman, close mic'), '🔴 a running batch shows the DESCRIPTION it was armed with');
  ok(running.includes(SAMPLE), '🔴 and the sample text IN FULL — truncating it is what made a wrong run invisible');
  ok(/Quality steps: 24/.test(running), 'and the quality steps it is using');
  // 📌 readonly, NOT disabled: a disabled textarea cannot be selected, and copying this text
  // back into the boxes above is the obvious next thing to want.
  ok((running.match(/<textarea readonly/g) || []).length === 2, 'both are readonly textareas — selectable and copyable, never disabled');
  ok(!/disabled/.test(running), 'and nothing in the panel is disabled');

  // 🔴 The whole point of the panel is that this text and the boxes above are different things.
  const stopped = bf.vcBatchForm({ status: 'stopped', prompt: 'x', sample_text: 'y', steps: 30 });
  ok(
    /Carry on continues with exactly this text/.test(stopped),
    'a STOPPED batch says Carry on continues with exactly this text, not with the boxes above',
  );
  ok(/Discard/.test(stopped) && /Batch/.test(stopped), 'and names the two-step that runs the boxes instead');
  ok(!/Carry on continues/.test(running), '…and a RUNNING batch does not offer that line — Carry on is not on screen for it');

  // The sample text is user prose going into innerHTML.
  const nasty = bf.vcBatchForm({
    status: 'running',
    prompt: '<img src=x onerror=1>',
    sample_text: '</textarea><script>bad()</script>',
    steps: 30,
  });
  ok(!/<script>/.test(nasty) && !/<img /.test(nasty), '🔴 the description and sample text are ESCAPED — they are user prose, not markup');
}

process.exit(failed ? 1 : 0);
