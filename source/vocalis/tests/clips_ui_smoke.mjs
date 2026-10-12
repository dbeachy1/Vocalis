// Vocalis 6.0 §7 — the Clips tab, driven by tests/test_clips_ui.py.
//
// test_clips_routes.py talks to the ROUTES. Nothing there would notice that the enhanced filter
// reads the wrong field, that the tab landed in the wrong slot in the strip, that a scene's
// name goes into the page unescaped, or that the list renders the transcript it was carefully
// not given. So the real helpers get sliced out of the real index.html and exercised.
//
// No npm dependencies (the devices_ui_smoke.mjs / kobold_ui_smoke.mjs convention).
//
// Usage: node clips_ui_smoke.mjs <path-to-index.html>
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { readPage } from './_websrc.mjs';

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  console.error('usage: node clips_ui_smoke.mjs <index.html>');
  process.exit(2);
}

// Normalized to LF — a CRLF checkout silently zeroes out newline-anchored regexes, and every
// check below then reads as passing. (See voices_ui_smoke.mjs, which learned this.)
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

const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
// 🔴 THE LONGEST inline block, NOT the last one. 7.1 (DESIGN_7_1_FRONTEND_REFACTOR.md §5.3) adds
// `<script type="module">` tags to the page, and the first one to land sat AFTER the app script —
// so `blocks.length - 1` silently selected a three-line shim and every slice below resolved to -1.
// That is not a hypothetical: it turned this spec red the moment the first module was extracted.
// The app script is the big one by three orders of magnitude, and it stays the big one until the
// split finishes, at which point there is no inline app script and these specs need rewriting
// against the real DOM anyway (§5's own note).
const main = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');

// 🔴 THE PAGE PLUS EVERY MODULE, FOR CHECKS THAT DO NOT CARE WHERE THE CODE LIVES (7.3-m2).
// `main` is the inline block ALONE, so a check written against it goes red the moment its
// subject moves into `src/webui/js/` — which is what 7.3 does to all 8,000 lines of it. That
// already bit this file once: the saved-tab migration below moved into `js/main.js` with the
// boot sequence, and this spec failed as though the saved `clips` tab would show a blank page,
// even though the migration was intact in the extracted module.
//
// ⚠️ Use `anywhere` ONLY for "this logic exists somewhere in the front end" claims. A check
// that genuinely means "this is in the page's inline script" must keep using `main`, or it
// stops testing what it says. `tests/_websrc.mjs` has the loader and §7.1 has the nine traps.
//
// 🔴 AND SLICE WITH `sliceDef`, NOT `main.indexOf` — 7.3-m7. The scene helpers below moved into
// js/scenes/scenes.js, so `main.indexOf('const scLib={')` answers -1 there forever. This file's
// `from > 0 && to > from` precondition would have caught that and exited 1, which is the good
// version of the failure; `sliceDef` is better still, because it follows the code into whichever
// file now holds it and throws with the marker NAMED when it is genuinely gone. §3.5.
const { loadWebSources, sliceDef, sliceText, sourceOf, stripModuleSyntax } = await import('./_websrc.mjs');
const anywhere = (await loadWebSources(htmlPath)).files.map(f => f.text).join('\n');

// ── 1. markup facts no render helper can show ────────────────────────────────
//
// 6.1 §10.1 moved Clips out of the top-level strip and under SillyTavern, alongside the other
// SillyTavern-specific views.
ok(!/<button data-tab="clips"/.test(html) && !/<section data-panel="clips"/.test(html), 'Clips is no longer a top-level tab (§10.1)');
ok(/<button data-sttab="clips"/.test(html), 'the SillyTavern sub-tab strip has a Clips button');
ok(/<div data-stpanel="clips"/.test(html), '…and a pane behind it');

// 🔴 The pane has to live INSIDE the SillyTavern section, not merely exist. switchTab() hides
// every `section[data-panel]` that is not the current one, so a stpanel left outside would be
// hidden by the top-level switch and never come back — the tab would open on nothing.
{
  const sect = html.indexOf('<section data-panel="sillytavern"');
  const end = html.indexOf('</section>', html.indexOf('data-stpanel="clips"'));
  const pane = html.indexOf('data-stpanel="clips"');
  ok(sect > 0 && pane > sect && end > pane, 'the Clips pane is nested inside the SillyTavern section, where switchTab can reach it');
  // §10.3 assumes both places a player can sit are in the one panel.
  const inner = html.slice(pane, end);
  ok(
    /id="scPlayer"/.test(inner) && /id="scList"/.test(inner),
    'and it brought its player and its list with it — scPlace() needs both in one panel',
  );
}

const ststrip = html.slice(html.indexOf('id="stTabs"'), html.indexOf('class="stwrap"'));
const storder = [...ststrip.matchAll(/data-sttab="([a-z]+)"/g)].map(m => m[1]);
// 7.0 §6.0 added Character Cards and World Books between the voice tab and this one, and
// renamed two of the three that were here — "Characters" became "Character Voices" (it sat
// next to "Character Cards" and the names differed by a noun) and "Clips" became "Scene Clips".
// The `data-sttab` VALUES did not change: they are persisted as `vocalis-sttab`, so renaming a
// value would land a returning browser on nothing.
ok(
  storder.join(',') === 'logs,characters,cards,books,personas,clips',
  `the sub-tabs read Logs · Character Voices · Character Cards · World Books · Personas · Scene Clips, in that order (${storder.join(' · ')})`,
);
ok(/data-sttab="clips"[^>]*>Scene Clips</.test(ststrip), 'the clips tab is called "Scene Clips" now (§6.0)');

// ⚠️ §7: "which is also why it cannot be called Library. That word is already two other things
// in this app, one of them a route."
const stLabels = [...ststrip.matchAll(/data-sttab="[a-z]+"[^>]*>([^<]+)</g)].map(m => m[1].trim());
// 7.0 §6.0 renamed it to "Scene Clips". The invariant this guards is unchanged and is about
// the word LIBRARY, not about the word Clips: the tab must never be called Library, because
// that word is already the Playground's own panel AND a Book sub-tab with a route behind it.
ok(
  stLabels.some(l => /Clips/.test(l)) && !stLabels.includes('Library'),
  'the tab is still a Clips tab, and is not Library — that word is already the Playground panel AND a Book sub-tab with a route',
);

// ⚠️ `sourceOf`, NOT `main` — 7.3-m2b moved `switchStTab` into js/st/tabs.js. The claim is
// "entering the Clips sub-tab is what loads the list", which is true wherever the switch lives;
// anchoring it on the page's inline block made it a claim about WHERE the switch is instead.
// ⚠️ `stTabApply`, NOT `switchStTab`, SINCE 7.5.6 — the dispatch body is unchanged, but the
// exported name moved to js/st/tabstate.js as a dispatcher so that scenes/scenes.js could stop
// importing js/st/tabs.js (a cycle). Two modules exporting `switchStTab` would also collide on
// `window` via _websrc.mjs's spec surface. This still asserts the real behavior, under its
// real name — it is NOT a loosened check.
// 🔴 ANCHORED ON THE DISPATCH LINE, NOT ON PROXIMITY — AND THE OLD FORM WAS VACUOUS. It read
// `/stTabApply[\s\S]{0,1500}?loadScenes\(\)/`, and the `?` makes it non-greedy, so it matched the
// FIRST `loadScenes()` after the definition. Measured in js/st/tabs.js: that was the COMMENT at
// distance 707 ("This was `logs / characters / else -> loadScenes()`" — prose about a refactor
// that had already happened). The real `case 'clips': loadScenes();` sits at distance 2489, i.e.
// OUTSIDE the 1500 window the check advertised. So for as long as this line has existed it has
// been proving that a comment mentions the function, never that the tab calls it.
//
// 8.3-m0's comment-stripping is what exposed it: blank the comment and the check went red against
// an app that was correct all along. Widening the bound would have restored the green and kept the
// hole — the fix is to name the dispatch, which prose cannot satisfy.
ok(/case\s*'clips'\s*:\s*loadScenes\(\)/.test(sourceOf('function stTabApply')), 'opening the sub-tab loads the scenes');
// 🔴 The Clips Search box shipped in 6.0 wired with a bare addEventListener, and `filtRows` reads
// `FILT[id]` — which only filtWire writes. So it re-rendered on every keystroke with an empty
// query and filtered NOTHING, for two releases, in a tab whose whole job is finding one clip
// among hundreds. Nothing here could see it: this file stubs filtRows to a pass-through, and the
// browser spec typed a query that was supposed to match. Assert the WIRING.
//
// ⚠️ AGAINST THE FILE THAT DEFINES `loadScenes`, NOT `main` — 7.3-m7 moved this wiring statement
// into js/scenes/scenes.js with the function it hands over, which is what took `renderScenes` off
// `_PARSE_TIME_SURFACE`. `sourceOf` follows it; `anywhere` would also have passed and would have
// stopped saying that the wiring lives WITH the feature, which is the half that matters.
ok(
  /filtWire\('scSearch'/.test(sourceOf('async function loadScenes(')),
  'the Clips search box goes through filtWire, which is the only thing that records the query',
);
// 🔴 The old two-way `logs ? … : characters` would start the character poll every time he
// opened Clips — an invisible poll that never stops, against a tab he is not looking at.
// 7.0 turned that two-way into a SWITCH, because two more panes arrived and the else-branch
// would have run loadScenes() for both of them. The invariant is the same and is now checked
// against the switch: exactly one case calls loadStChars, and the stops happen unconditionally
// before the dispatch, so no pane can inherit another's poll.
{
  // `sliceDef` rather than `main.indexOf`, for the same reason as §3 below: `switchStTab` is
  // sub-tab machinery and moves to js/ui/tabs.js at §5's m2, at which point a `main`-anchored
  // lookup answers -1 and these four checks report the dispatch as broken. 7.3-m7.
  const body = sliceDef('function stTabApply'); // 7.5.6 — renamed, see above
  const fn = body.slice(0, body.indexOf('\n}') + 2);
  const cases = [...fn.matchAll(/case '([a-z]+)':\s*([^;]*);/g)].map(m => [m[1], m[2].trim()]);
  // The KEYS, not a count: a bare `=== 6` passes just as happily when a pane is renamed or one
  // case is dropped and another added, which is the change this guard exists to catch.
  ok(
    cases.map(c => c[0]).join(',') === 'logs,characters,cards,books,personas,clips',
    `switchStTab dispatches on every sub-tab (${cases.map(c => c[0]).join(',')})`,
  );
  const pollers = cases.filter(([, body]) => /loadStChars/.test(body)).map(([k]) => k);
  ok(pollers.join(',') === 'characters', `the character poll starts for Character Voices ONLY (${pollers.join(',') || 'nothing'})`);
  const scenes = cases.filter(([, body]) => /loadScenes/.test(body)).map(([k]) => k);
  ok(
    scenes.join(',') === 'clips',
    `and the scene list loads for Scene Clips ONLY — not as an else-branch (${scenes.join(',') || 'nothing'})`,
  );
  ok(/stLogStop\(\);\s*stPollStop\(\);/.test(fn), "both stops run before the dispatch, so no pane inherits another pane's poll");
}
// Existing browsers may have saved `clips` as a top-level tab. Without migration, that saved
// selection would open a blank page after the tab moved under SillyTavern.
// ⚠️ `anywhere`, not `main`: the boot sequence moved to `js/main.js` in 7.3-m2 and took this
// migration with it. The claim is "the migration exists", not "the migration is in the page".
//
// 🔴 THREE CLAIMS ABOUT THE SHAPE, NOT ONE MATCH ON THE LITERAL — 7.3-m2b. This was
// `/if\(t==='clips'\)\{stTab='clips';t='sillytavern';\}/`, one regex pinning the statement
// character for character, and m2b had to change those characters: `stTab` became a `let` inside
// js/st/tabstate.js, so the bare assignment became `stTabSet('clips')`. ✅ **The check going red was
// correct and useful** — a bare `stTab='clips'` would have created a `window.stTab` that nothing
// reads, leaving a saved tab silently landing on Logs with no error.
//
// ⚠️ BUT AN EXACT-TEXT MATCH ON A THREE-PART STATEMENT CANNOT SAY WHICH PART BROKE, and the next
// refactor of the same line will move the characters again (§11.19 — a pinned literal is a
// constant). So it asks the three things the migration actually has to do, separately.
{
  const mig = /if\s*\(\s*t\s*===\s*'clips'\s*\)\s*\{([^}]*)\}/.exec(anywhere);
  ok(!!mig, 'the saved-tab migration tests for a top-level "clips" tab');
  const body = mig ? mig[1] : '';
  ok(/'clips'/.test(body.replace(/t\s*===\s*'clips'/, '')), '…and remembers "clips" as the SUB-tab, so the pane it opens is the Clips one');
  ok(/t\s*=\s*'sillytavern'/.test(body), '…and redirects the top-level tab to SillyTavern, which is where the pane lives now');
}

// ── 2. §7.1's filter, in BOTH places ─────────────────────────────────────────
ok(/id="scEnhFilter"/.test(html), 'the Clips list has the enhanced filter');
ok(
  /id="pgEnhFilter"/.test(html),
  '⚠️ and so does the PLAYGROUND library — enhancement has produced two clips per render there ' +
    'since 4.1, so it has this problem already',
);
for (const id of ['scEnhFilter', 'pgEnhFilter']) {
  const sel = html.slice(html.indexOf(`id="${id}"`));
  const opts = [...sel.slice(0, 400).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  ok(
    opts.length === 3 && opts.includes('') && opts.includes('1') && opts.includes('0'),
    `${id} is three-state: all · enhanced · not enhanced (${JSON.stringify(opts)})`,
  );
}

// ── 3. the helpers, run for real ─────────────────────────────────────────────
// Anchored on the opening brace, not the whole literal: 6.1 §10.3 added fields to scLib and the
// exact-text version of this line failed the slice, which fails every check below it.
//
// ⚠️ NO `ok(…, 'located the scene helpers')` PRECONDITION ANY MORE — `sliceDef` throwing IS that
// check, and it names the marker in the message rather than making the reader guess which of two
// it was. That is why the check count in this file falls by one at 7.3-m7 (_websrc.mjs's header,
// "CONVERTING A HARNESS").
//
// 🔴 `stripModuleSyntax` IS NOT OPTIONAL NOW. The slice starts at `export const scLib={` in
// js/scenes/scenes.js, and `export` is a SyntaxError in `vm.runInContext`, which compiles a
// CLASSIC script. The failure would have read as "the whole Clips tab is broken".
// ⚠️ RE-ANCHORED AT 8.8-m10, AND THIS MARKER CLAIMS NOTHING. It is purely the LAST LINE of the
// slice fed to `vm` — `$()` became honestly nullable, so that line now carries a cast and the
// byte sequence moved. `relaxSpace` relaxes whitespace, not parens, which is why an exact marker
// could not survive. The slice boundary is the same statement it always was.
const scenesSrc = stripModuleSyntax(sliceText('const scLib={', "($('scRefresh')).onclick=loadScenes;"));

const mkEl = () => ({
  innerHTML: '',
  textContent: '',
  value: '',
  disabled: false,
  checked: false,
  dataset: {},
  style: { removeProperty() {}, setProperty() {} },
  classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
  addEventListener() {},
  // 9.6.7 — `scPlace` is real code this smoke now reaches: the play-button checks below set
  // `scLib.au`, and with an element in hand `scPlace` stops returning early and moves it into a
  // slot. No-ops rather than a real tree — nothing here asserts WHERE the player landed (that is
  // clips_chapters_browser_spec.mjs's job, in pixels); this only has to not throw.
  appendChild() {},
  removeChild() {},
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
});
// 🔴 A FACTORY, NOT ONE OBJECT — 9.0.13. The enhancement-queue checks at the end need a vm whose
// MODULE-LEVEL state is fresh (the in-flight ref set, the retry timer, `scLib.enhQ` itself), and
// a second one standing on a one-card box. Reusing the page-wide `sandbox` for those would have
// made their result depend on the ninety checks that ran before them — the kind of order coupling
// that turns one real failure into three confusing ones.
/** @param {object} [over] - fields to replace in the stub environment */
function mkSandbox(over = {}) {
  const els = {};
  const box = {
    $: id => (els[id] ||= mkEl()),
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]),
    fmtSize: b => (b == null ? '' : `${b}B`),
    // 9.2.1 — the enhancement row's sentence quotes an ETA. Real one, not a stub: the checks
    // below assert the exact words, and a stub would let a formatter change slip past them.
    fmtEta: s => {
      s = Math.max(0, Math.round(s || 0));
      if (s < 90) return `${s}s`;
      const h = Math.floor(s / 3600),
        m = Math.round((s % 3600) / 60);
      return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    },
    // m2: an upload row has no ISO `created`, so the Built column falls back to the epoch.
    fmtDate: t => (t ? `d${t}` : ''),
    modal: async () => 1,
    jpost: async () => ({ job_id: 'j1' }),
    setInterval: () => 0,
    clearInterval: () => {},
    // ⚠️ RECORDED, NEVER RUN. The queue defers its follow-up pump with `setTimeout(fn,0)`; a stub
    // that ran `fn` synchronously would pump from INSIDE `scEnhance`, before its `finally` has
    // taken the ref out of the in-flight set — which is a state the real page never reaches, and
    // the checks below would be measuring the stub rather than the pump.
    setTimeout: fn => box.__timers.push(fn),
    clearTimeout: () => {},
    __timers: [],
    // The shared matcher. Its real job is tested elsewhere; here it only has to pass rows
    // through so the filter under test is the one being measured.
    filtRows: (_id, rows) => rows,
    jget: async () => [],
    // 9.5.7 - the column sort is remembered through UIS, like `vSort` in Character Voices.
    // Without this `scSortBy` throws a ReferenceError on the first header click; the
    // enhancement-queue sandbox below stubs the same two methods for the same reason.
    UIS: { getItem: () => null, setItem: () => {} },
    // 🔴 9.5.7 - THE CHARACTER COLUMN HAS NEVER BEEN RENDERED IN THIS VM. `scWhoCell` calls
    // `stFaceFor` (st/chars.js, outside the slice) as soon as a row HAS a speaker, and no
    // fixture here had one until the sort checks needed a column that some rows are blank in.
    // Without the stub every check below the first `characters:[…]` row dies on a
    // ReferenceError, which presents as the sort being broken.
    // 11.2.6 - the Clips row calls `stSceneFaceFor` now, which chooses among same-named documents.
    stSceneFaceFor: name => `<span class="face" title="${name}">${String(name || '?')[0]}</span>`,
    // 6.3: the page's enhance-availability state, which lives OUTSIDE the sliced range
    // (it is 4.1's, shared with the Playground and Book controls). Default it to a box
    // that CAN enhance, and flip it below. `cards` is 9.0.13's fan-out limit.
    enh: { ok: true, msg: '', cards: 1 },
    encodeURIComponent,
    ...over,
  };
  vm.createContext(box);
  vm.runInContext(
    scenesSrc +
      '\n;this.scLib=scLib;this.renderScenes=renderScenes;' +
      'this.scFiltered=scFiltered;this.scFmtDur=scFmtDur;this.scKey=scKey;' +
      'this.scHas=scHas;this.renderJoinTray=renderJoinTray;' +
      'this.scJoinTotal=scJoinTotal;this.scScenesSel=scScenesSel;' +
      'this.scStop=scStop;this.scOwns=scOwns;' +
      'this.scEnhQueue=scEnhQueue;this.scEnhSync=scEnhSync;this.scEnhApply=scEnhApply;this.scEnhRestore=scEnhRestore;this.scEnhStrip=scEnhStrip;' +
      'this.scEnhPoll=scEnhPoll;this.scEnhStopAll=scEnhStopAll;this.scEnhLive=scEnhLive;' +
      'this.scEnhSelectable=scEnhSelectable;this.scEnhSelected=scEnhSelected;this.scSyncSel=scSyncSel;' +
      // 9.5.6 - the reorder and the repaint guard. Both are decisions rather than DOM work,
      // which is exactly why they live inside the slice and are reachable from here.
      'this.scEnhMove=scEnhMove;this.scEnhDragBegin=scEnhDragBegin;this.scEnhDragEnd=scEnhDragEnd;' +
      // 9.5.7 - the column sort. A decision, not DOM work, so it lives inside the slice; the
      // delegated `th[data-sort]` click that calls it is the only part that needs a document.
      'this.scSortBy=scSortBy;this.scSortVal=scSortVal;' +
      // 11.2.5 - the face lookup, by SillyTavern avatar before name.
      'this.scFaceFor=scFaceFor;this.scLoadStAvatars=scLoadStAvatars;',
    box,
  );
  return box;
}
const sandbox = mkSandbox();

const RAW = {
  kind: 'scene',
  ref: 'ferry_ab12cd34',
  name: 'The ferry',
  enhanced: false,
  origin: 'st:Test Character 1',
  created: '2026-07-31T18:00:00',
  created_ts: 1785520800, // 9.5.7 - the real rows always carry one; see below
  duration_s: 2760,
  n_entries: 74,
  n_skipped: 2,
  size: 33_120_000,
  audio_url: '/clips/scenes/ferry_ab12cd34/audio',
};
const ENH = {
  kind: 'scene',
  ref: 'ferry_enhanced_ff00ff00',
  name: 'The ferry',
  enhanced: true,
  origin: 'st:Test Character 1',
  created: '2026-07-31T18:20:00',
  created_ts: 1785522000,
  duration_s: 2760,
  n_entries: 74,
  n_skipped: 2,
  size: 88_320_000,
  raw_ref: 'ferry_ab12cd34',
  audio_url: '/clips/scenes/ferry_enhanced_ff00ff00/audio',
};

// §3.5a keeps BOTH takes, so the list has two rows for one build and the filter is how you
// tell them apart.
sandbox.scLib.items = [RAW, ENH];
sandbox.$('scEnhFilter').value = '';
sandbox.renderScenes();
const all = sandbox.$('scList').innerHTML;
ok(/ferry_ab12cd34/.test(all) && /ferry_enhanced_ff00ff00/.test(all), 'both takes of one build are listed as two rows (§3.5a)');
ok(/enhanced<\/span>/.test(all), 'the enhanced one wears a pill');
ok(/46 min/.test(all), 'the length is shown in minutes, not raw seconds');
ok(/74 msg/.test(all), 'a scene row still says how many messages went into it');
// 🔴 §9, and it is the ONLY place that promise is visible. m2 flattened three stores into one
// row and very nearly dropped this on the way — with the assertion edited to match, which is
// how a guarantee disappears without anyone deciding to remove it.
ok(/\(\+2 skipped\)/.test(all), 'this IS the §9 promise on screen: messages with nothing speakable are surfaced, not silently dropped');

sandbox.$('scEnhFilter').value = '0';
ok(
  sandbox
    .scFiltered()
    .map(s => s.ref)
    .join() === 'ferry_ab12cd34',
  '🔴 "not enhanced" leaves exactly the raw take — this IS the cleanup workflow (§7.1): ' + 'filter, select all, delete',
);
sandbox.$('scEnhFilter').value = '1';
ok(
  sandbox
    .scFiltered()
    .map(s => s.ref)
    .join() === 'ferry_enhanced_ff00ff00',
  '…and "enhanced" leaves exactly the twin, for downloading just those',
);

// ⚠️ §5.1 — the LIST route deliberately does not carry `entries`, and the renderer must not
// grow a use for it. A row that printed the transcript would put the conversation on screen in
// a panel that exists to show file metadata.
sandbox.$('scEnhFilter').value = '';
sandbox.scLib.items = [{ ...RAW, entries: [{ text: 'the unmistakable secret words' }] }];
sandbox.renderScenes();
ok(!/unmistakable/.test(sandbox.$('scList').innerHTML), '§5.1: the list renders no message text even when handed some');

// A scene name is user-provided text and reaches `innerHTML`.
sandbox.scLib.items = [{ ...RAW, name: '<img src=x onerror=alert(1)>' }];
sandbox.renderScenes();
ok(
  !/<img src=x/.test(sandbox.$('scList').innerHTML) && /&lt;img/.test(sandbox.$('scList').innerHTML),
  'the scene name is escaped on the way into the page',
);

// Empty state points at where scenes come from — the Clips tab is somewhere you go
// deliberately, so a bare "nothing here" would strand you.
sandbox.scLib.items = [];
sandbox.renderScenes();
ok(/shift-click/.test(sandbox.$('scList').innerHTML), 'the empty state says how to make one (shift-click a ▶ button in SillyTavern)');

// ── 4. durations read as durations ───────────────────────────────────────────
ok(sandbox.scFmtDur(45) === '45s', '45s');
ok(sandbox.scFmtDur(2760) === '46 min', "46 min (§2.3's own example)");
ok(sandbox.scFmtDur(3900) === '1h 5m', '1h 5m');
ok(sandbox.scFmtDur(null) === '', 'and an unknown duration renders as nothing, not "0s"');

// ══ 6.0-m2 §7 — the rest of the tab ═════════════════════════════════════════════════════

// The kind filter, alongside §7.1's enhanced one.
ok(/id="scKindFilter"/.test(html), 'the Clips list has a kind filter');
{
  const sel = html.slice(html.indexOf('id="scKindFilter"'));
  const opts = [...sel.slice(0, 500).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  ok(
    opts.length === 4 && ['', 'scene', 'playground', 'upload'].every(v => opts.includes(v)),
    `scKindFilter is all · scenes · playground · uploads (${JSON.stringify(opts)})`,
  );
}

const PG = {
  kind: 'playground',
  ref: 'sample-voice/hello_1234',
  name: 'Hello there',
  enhanced: false,
  origin: 'sample-voice.wav',
  created: '2026-07-31T10:00:00',
  created_ts: 1785492000,
  duration_s: 12,
  size: 100,
  audio_url: '/playground/clips/sample-voice/hello_1234/audio',
};
const UP = {
  kind: 'upload',
  ref: 'a read.wav',
  name: 'a read',
  enhanced: false,
  origin: 'uploaded',
  created: null,
  created_ts: 1785000000,
  duration_s: 30,
  size: 200,
  audio_url: '/train/sources/a%20read.wav/audio',
};

sandbox.scLib.items = [RAW, PG, UP];
sandbox.scLib.sel = [];
sandbox.$('scEnhFilter').value = '';
sandbox.$('scKindFilter').value = '';
sandbox.renderScenes();
const three = sandbox.$('scList').innerHTML;
ok(
  /scene<\/span>/.test(three) && /playground<\/span>/.test(three) && /upload<\/span>/.test(three),
  'all three stores are listed, each wearing its kind',
);
ok(
  /\/playground\/clips\/sample-voice\/hello_1234\/audio/.test(three),
  '🔴 a playground row links its OWN route, slash intact — %2F would 404 as a missing clip',
);
ok(/\/train\/sources\/a%20read.wav\/audio/.test(three), 'and an upload links the Speech store');
// Chapters and Rename are scene verbs; a Playground clip is renamed in the Playground tab.
ok((three.match(/data-act="chapters"/g) || []).length === 1, 'only the scene row offers Chapters — this tab is a view, not a fourth store');

// ── 7.5 — 🎓 Train, on the row: now ＋ Speech (Docker edition) ───────────────────────────────
//
// Docker edition: Voice Training is not part of the product, so the 🎓 Train button is now the
// ＋ Speech button, which copies the same two sources into the Speech library (the shared clip
// store) through the same per-kind import routes. The three rows above cover the two supported
// sources: a scene and a Playground clip each get the button, pointed at their OWN store's route,
// and an upload does not — the Speech store IS that library, so ＋ Speech on one of those copies a
// file onto itself. The 7.5 one-voice-per-dataset warning covered only training and is gone.
{
  const btns = [...three.matchAll(/data-act="speech" data-ref="([^"]*)" data-kind="([^"]*)"/g)].map(m => m[2]);
  ok(btns.join(',') === 'scene,playground', `＋ Speech is offered on the scene and the Playground clip (${btns.join(',') || 'nothing'})`);
  ok(
    !/data-act="speech"[^>]*data-kind="upload"/.test(three),
    '🔴 and NOT on an upload — that store IS the Speech library, so the button would copy a ' +
      'file onto itself and 409 against the row you pressed',
  );
  ok(!/data-act="train"/.test(three), 'and no row offers 🎓 Train, because Voice Training is not part of this edition');
  // The route is chosen from the row's kind, the way the audio URL is (clip_sources.audio_url).
  // A scene posting to /train/import would be answered 404 by the Playground resolver.
  const src = scenesSrc;
  ok(
    /scene:\s*'\/train\/import_scene'/.test(src) && /playground:\s*'\/train\/import'/.test(src),
    "each kind posts to its own store's import route",
  );
}
// ── 9.5.7 — the sortable column headers ──────────────────────────────────────────────────────
//
// 🔴 THE ORDER IS READ OFF THE RENDERED ROWS, not off `scFiltered()`'s return value. The
// header, the arrow and the row order are three things that can disagree — a sort that orders
// the array while the table draws something else is exactly the failure a caller-side check
// cannot see — so every one of these reads the same HTML the browser would.
{
  /** The `data-kind` of each row, top to bottom, as the table currently draws them. */
  const order = () => [...sandbox.$('scList').innerHTML.matchAll(/<tr data-ref="([^"]*)"/g)].map(m => m[1]);
  /** The header cell for one column, as markup, so the arrow and the `data-sort` are both visible. */
  const head = k => (sandbox.$('scList').innerHTML.match(new RegExp(`<th[^>]*data-sort="${k}"[^>]*>[^<]*`)) || [''])[0];

  sandbox.scLib.items = [RAW, PG, UP];
  sandbox.scLib.sort = 'created_ts';
  sandbox.scLib.dir = -1;
  sandbox.renderScenes();
  ok(
    order().join(',') === 'ferry_ab12cd34,sample-voice/hello_1234,a read.wav',
    `the default order is newest first, which is the order /clips/items already answers (${order().join(',')})`,
  );
  ok(/ ▼/.test(head('created_ts')), 'and the Built header wears ▼ to say so');
  ok(!/[▲▼]/.test(head('name')) && !/[▲▼]/.test(head('kind')), '🔴 …on the ACTIVE column ONLY — an arrow on every header says nothing');

  // Every column the header row offers is a column the sort can actually take. A `data-sort`
  // the switch in `scSortVal` does not answer renders an arrow and orders nothing.
  const cols = [...sandbox.$('scList').innerHTML.matchAll(/data-sort="([^"]*)"/g)].map(m => m[1]);
  ok(
    cols.join(',') === 'who,name,kind,origin,created_ts,duration_s',
    `six sortable columns, in the order they are drawn (${cols.join(',')})`,
  );

  sandbox.scSortBy('created_ts'); // the same column again — flip
  ok(order().join(',') === 'a read.wav,sample-voice/hello_1234,ferry_ab12cd34', `clicking the sorted column flips it (${order().join(',')})`);
  ok(/ ▲/.test(head('created_ts')), '…and the arrow turns over with it');

  sandbox.scSortBy('name'); // a NEW column starts ascending, not at whatever the last one was
  // 🔴 `localeCompare`, NOT `<`. The names here are 'a read', 'Hello there', 'The ferry', and a
  // codepoint comparison would put every capital ahead of every lower-case letter — 'The ferry'
  // above 'a read', which is not what "A→Z" means to anyone reading the column. This expectation
  // was written the ASCII way first and the code was right; the check was wrong.
  ok(order().join(',') === 'a read.wav,sample-voice/hello_1234,ferry_ab12cd34', `Name sorts A→Z on its first click (${order().join(',')})`);
  ok(/ ▲/.test(head('name')) && !/[▲▼]/.test(head('created_ts')), 'the arrow moved to Name and left Built bare');

  sandbox.scSortBy('duration_s'); // …and a LENGTH column starts at the long end
  ok(order()[0] === 'ferry_ab12cd34', `Length sorts longest-first on its first click (${order().join(',')})`);

  // 🔴 A ROW WITH NOTHING IN THE COLUMN SINKS, WHICHEVER WAY THE ARROW POINTS. Only the scene
  // has a character, so ascending and descending must BOTH leave the other two underneath it —
  // a blank compared as '' rides to the top of an ascending sort, which is where a row you
  // cannot see a value for is most confusing.
  sandbox.scLib.items = [RAW, PG, UP].map(r => (r === RAW ? { ...RAW, characters: ['Test Character 1'] } : r));
  sandbox.scSortBy('who');
  ok(order()[0] === 'ferry_ab12cd34', `ascending by Character puts the only row that HAS one first (${order().join(',')})`);
  sandbox.scSortBy('who');
  ok(order()[0] === 'ferry_ab12cd34', `🔴 …and so does descending — the blanks sink both ways (${order().join(',')})`);

  // The tick column is a `<th>` too, and it must not be a sort handle: `scSortBy` is the ONE
  // door in, and it refuses anything that is not a column rather than setting `scLib.sort` to
  // a name nothing answers and rendering an arrow over an unsorted list.
  ok(
    sandbox.scSortBy('') === false && sandbox.scSortBy('favorite') === false,
    'a header that is not a column is refused, not half-applied',
  );
  ok(sandbox.scLib.sort === 'who', '…and the refusal left the current column alone');

  // 🔴 PUT THE DEFAULT BACK BEFORE LEAVING. This sandbox is shared with every check below, and
  // several of them assert ROW ORDER rather than row content — §10.5's "the player row goes
  // between the clip and its chapters" reads the rendered POSITIONS of RAW and PG. Leaving the
  // list sorted by Character re-orders that pair and fails two checks that have nothing to do
  // with sorting, in a place that gives no hint the cause is up here.
  sandbox.scLib.sort = 'created_ts';
  sandbox.scLib.dir = -1;
}

sandbox.$('scKindFilter').value = 'upload';
ok(
  sandbox
    .scFiltered()
    .map(s => s.ref)
    .join() === 'a read.wav',
  'the kind filter narrows to one store',
);
sandbox.$('scKindFilter').value = '';

// 🔴 Identity is the (kind, ref) PAIR. A scene and an upload can both be called "hello".
{
  const a = { ...RAW, kind: 'scene', ref: 'hello' };
  const b = { ...UP, kind: 'upload', ref: 'hello' };
  ok(
    sandbox.scKey(a) !== sandbox.scKey(b),
    '🔴 the same ref in two stores is two different keys — a set keyed on ref alone would ' +
      'join or delete the wrong file the first time a name repeated',
  );
  sandbox.scLib.sel = [a];
  ok(sandbox.scHas(a) && !sandbox.scHas(b), '…and membership tests on the pair');
}

// §7: "default order is the order ticked, arrows fix the rest."
sandbox.scLib.sel = [UP, RAW, PG];
sandbox.renderJoinTray();
const tray = sandbox.$('scJoinList').innerHTML;
ok(
  tray.indexOf('a read') < tray.indexOf('The ferry') && tray.indexOf('The ferry') < tray.indexOf('Hello there'),
  '🔴 the join tray lists clips in TICK order, not sorted — a sort would undo every arrow press',
);
ok(/data-jup="1"/.test(tray) && /data-jdn="1"/.test(tray) && /data-jrm="1"/.test(tray), 'every row has ↑ ↓ and ✕');
ok(!/data-jup="0"[^>]*>(?![\s\S]*disabled)/.test(tray) && /data-jup="0" disabled/.test(tray), 'the first row cannot move up');

// The running total is the clips PLUS the gaps between them — the number that tells you
// whether you are about to make a two-hour file.
sandbox.$('scJoinGap').value = '0.7';
ok(
  Math.abs(sandbox.scJoinTotal() - (30 + 2760 + 12 + 0.7 * 2)) < 0.01,
  `the running total counts the gaps between clips (${sandbox.scJoinTotal()})`,
);
sandbox.$('scJoinGap').value = '0';
ok(Math.abs(sandbox.scJoinTotal() - (30 + 2760 + 12)) < 0.01, 'and a zero gap joins them back to back');

// Delete and ⬇ are SCENE verbs and act on the scene subset rather than refusing the selection.
sandbox.scLib.sel = [UP, RAW, PG];
ok(
  sandbox
    .scScenesSel()
    .map(s => s.ref)
    .join() === 'ferry_ab12cd34',
  '🔴 Delete/Download-selected act on the SCENES in the selection — deleting a Playground clip ' +
    'or an upload belongs to the tab that owns its consequences',
);
sandbox.renderScenes();
ok(sandbox.$('scDelSel').textContent === 'Delete selected (1)', `and the button counts only those (${sandbox.$('scDelSel').textContent})`);
ok(sandbox.$('scJoinBtn').textContent === '⛓ Join selected (3)', `while Join counts all three (${sandbox.$('scJoinBtn').textContent})`);

// One clip is not a join.
sandbox.scLib.sel = [RAW];
sandbox.renderScenes();
ok(sandbox.$('scJoinBtn').disabled === true, 'Join stays off with one clip ticked');
sandbox.scLib.sel = [RAW, PG];
sandbox.renderScenes();
ok(sandbox.$('scJoinBtn').disabled === false, '…and comes on at two');

// A clip name reaches the TRAY through innerHTML too, and it is the same user prose.
sandbox.scLib.sel = [{ ...PG, name: '<img src=x onerror=alert(1)>' }, RAW];
sandbox.renderJoinTray();
ok(!/<img src=x/.test(sandbox.$('scJoinList').innerHTML), 'a clip name is escaped on the way into the join tray as well');

// ══ 6.1 §10.3 — the chapters open in a detail row ═══════════════════════════════════════
// The geometry and the playback live in clips_chapters_browser_spec.mjs, which needs Chrome and
// ffmpeg. These are the parts that can be checked anywhere, and one of them is an invariant a
// browser test would NOT catch: a detail row that spans the wrong number of columns still lands
// under the right row and still looks plausible in a screenshot.
sandbox.scLib.sel = [];
sandbox.scLib.items = [RAW, PG];
sandbox.scLib.open = null;
sandbox.renderScenes();
ok(!/scDet/.test(sandbox.$('scList').innerHTML), 'nothing is expanded until a Chapters button is pressed');

sandbox.scLib.open = RAW.ref;
sandbox.scLib.chap[RAW.ref] = [
  { offset_s: 0, character: 'Test Character 1', text: 'the first line' },
  { offset_s: 4.7, character: 'Test Character 2', text: 'the second' },
];
sandbox.renderScenes();
const opened = sandbox.$('scList').innerHTML;
ok((opened.match(/<tr class="scDet"/g) || []).length === 1, 'exactly one detail row is emitted for the open scene');
ok(
  opened.indexOf(`data-detref="${RAW.ref}"`) > opened.indexOf(`<tr data-ref="${RAW.ref}"`) &&
    opened.indexOf('data-detref') < opened.indexOf(`<tr data-ref="${PG.ref}"`),
  'and it is emitted BETWEEN its own row and the next one — the accordion, not a footer',
);
{
  // 🔴 colspan has to equal the header count or the table skews the moment a column is added.
  const cols = (opened.match(/<th[ >]/g) || []).length; // `<th`, not `<thead`
  const span = Number((opened.match(/<td colspan="(\d+)"/) || [])[1]);
  ok(cols === span, `the detail cell spans every column (${span} of ${cols} headers)`);
}
ok(/data-seek="4.7"/.test(opened) && /the second/.test(opened), 'the chapters render from the cached manifest, each with its offset');
// §10.5 replaced §10.4's in-the-detail-row player with a row of its own, so the detail row must
// NOT still be carrying a second slot — two slots is two places scPlace could append into, and
// the one it picks would then depend on render order.
ok(!/class="scDetPlayer"/.test(opened), '§10.5: the detail row no longer carries a player slot of its own');

// ⚠️ Transcript text is user-provided and reaches `innerHTML` exactly like a name does.
sandbox.scLib.chap[RAW.ref] = [{ offset_s: 0, character: '<b>K</b>', text: '<img src=x onerror=alert(1)>' }];
sandbox.renderScenes();
ok(
  !/<img src=x/.test(sandbox.$('scList').innerHTML) && !/<b>K<\/b>/.test(sandbox.$('scList').innerHTML),
  'chapter text and speaker are escaped on the way into the page',
);
sandbox.scLib.open = null;

// ══ 6.1 §10.5 — the player sits under the row it is playing, whatever kind it is ═════════
// The player belongs inline with its clip row, just like the chapter details, rather than at the
// top of the tab.
//
// The geometry is the browser spec's job. What is checkable here is the MARKUP invariant it rests
// on: one player row, emitted for the owning clip only, between that clip's row and its chapters.
sandbox.scLib.items = [RAW, PG];
sandbox.scLib.chap[RAW.ref] = [{ offset_s: 0, character: 'Test Character 1', text: 'the first line' }];
sandbox.scLib.playing = null;
sandbox.scLib.open = null;
sandbox.renderScenes();
ok(
  !/class="scPlay"/.test(sandbox.$('scList').innerHTML),
  'no player row until something is playing — an empty bar is chrome, not a control',
);

sandbox.scLib.playing = { kind: RAW.kind, ref: RAW.ref };
sandbox.scLib.open = RAW.ref;
// 🔴 9.6.7 — THE BUTTON NOW ASKS THE ELEMENT, NOT ONLY THE OWNERSHIP. `scSounding()` reads
// `scLib.au`, so a fixture that sets `playing` and leaves `au` null is describing a state the app
// cannot be in (the two are assigned together in `scEnsurePlayer`) and would render ▶ Play over a
// clip this block is about to call playing. Two fields is all the BUTTON reads.
//
// ⚠️ AND FOUR MORE THAT `scStop` REACHES FOR. With a real element in `scLib.au` the teardown at
// the end of this section stops being a no-op and runs its whole body — a better test than the
// null it replaced, and without them it dies on `au.pause is not a function` several checks later,
// a long way from the fixture that caused it.
const fakeAudio = (over = {}) => ({
  paused: false,
  ended: false,
  parentNode: null,
  pause() {},
  load() {},
  removeAttribute() {},
  ...over,
});
sandbox.scLib.au = fakeAudio();
sandbox.renderScenes();
const playing = sandbox.$('scList').innerHTML;
ok((playing.match(/<tr class="scPlay"/g) || []).length === 1, 'exactly one player row, for the clip that owns the player');
{
  // 🔴 THE §10.5 invariant: its own row, then the player, then the chapters, then the next
  // clip. "Below the row I clicked play on" is an ordering fact, and the browser spec measures
  // it in pixels — this is the same claim in the markup, where it fails loudly and cheaply.
  const row = playing.indexOf(`<tr data-ref="${RAW.ref}"`);
  const play = playing.indexOf('<tr class="scPlay"');
  const det = playing.indexOf('<tr class="scDet"');
  const next = playing.indexOf(`<tr data-ref="${PG.ref}"`);
  ok(
    row >= 0 && row < play && play < det && det < next,
    'the player row goes between the clip and its chapters — not at the top of the tab',
  );
}
{
  // The same skew trap the detail row has: a player row spanning the wrong number of columns
  // still looks plausible until someone adds a column.
  const cols = (playing.match(/<th[ >]/g) || []).length;
  const span = Number((playing.match(/<tr class="scPlay"[\s\S]*?<td colspan="(\d+)"/) || [])[1]);
  ok(cols === span, `the player cell spans every column (${span} of ${cols} headers)`);
}
{
  // §10.5's second half: "the play button should go to a stop… with a red icon, and that hides
  // the playback bar as well." One button, both states, and the state is per row.
  const btn = ref => playing.match(new RegExp(`<button class="([^"]*)" data-act="play" data-ref="${ref}"[^>]*>([^<]*)<`)) || [];
  const mine = btn(RAW.ref),
    other = btn(PG.ref);
  ok(mine[2] === '■ Stop' && /\bdanger\b/.test(mine[1] || ''), `the playing clip's button reads Stop, in red (${mine[2]})`);
  ok(other[2] === '▶ Play' && !/\bdanger\b/.test(other[1] || ''), `and every other row still reads Play (${other[2]})`);
}
{
  // 🔴 When playback ends, the button must return to Play and the player row must disappear. Playback
  // state alone is insufficient because the ownership marker can remain after the audio ends.
  //
  // `scLib.playing` is set in `scEnsurePlayer` and cleared in `scStop` and NOWHERE ELSE, and it
  // was the button's only input — so the ordinary way playback ends changed nothing on screen.
  // This is that state in the markup: still the owner, no longer sounding.
  //
  // ⚠️ THE PRESS IS UNCHANGED — ✕ Close and ■ Stop are ONE action under two honest names, so the
  // player row still belongs to this clip and the click still runs `scStop`. What must not
  // survive the end of the audio is the RED: `danger` says "this interrupts something", and
  // closing a finished player interrupts nothing.
  sandbox.scLib.au = fakeAudio({ paused: true, ended: true });
  sandbox.renderScenes();
  const ended = sandbox.$('scList').innerHTML;
  const btn =
    ended.match(new RegExp(`<button class="([^"]*)" data-act="play" data-ref="${RAW.ref}"[^>]*title="([^"]*)"[^>]*>([^<]*)<`)) || [];
  ok(btn[3] === '✕ Close' && !/\bdanger\b/.test(btn[1] || ''), `a clip that reached its end reads Close, not red Stop (${btn[3]})`);
  ok(/[Pp]ut the player away/.test(btn[2] || ''), `and its tooltip is about putting the player away (${btn[2]})`);
  ok((ended.match(/<tr class="scPlay"/g) || []).length === 1, 'the player row is still there until he closes it');
  // Paused on the transport bar is the same claim, one axis narrower — the bar is where pause
  // lives, and nothing in this file ever hears about it.
  sandbox.scLib.au = fakeAudio({ paused: true, ended: false });
  sandbox.renderScenes();
  const paused = sandbox.$('scList').innerHTML.match(new RegExp(`data-act="play" data-ref="${RAW.ref}"[^>]*>([^<]*)<`)) || [];
  ok(paused[1] === '✕ Close', `and so does a clip paused on the player bar (${paused[1]})`);
  sandbox.scLib.au = fakeAudio();
  sandbox.renderScenes();
}

// 🔴 The complaint was about a PLAYGROUND clip — it has no Chapters button, so before §10.5 it
// had no row to live in and was stuck with the bar at the top of the section. That is the case
// that has to work, not just the scene one.
sandbox.scLib.playing = { kind: PG.kind, ref: PG.ref };
sandbox.renderScenes();
{
  const html2 = sandbox.$('scList').innerHTML;
  const row = html2.indexOf(`<tr data-ref="${PG.ref}"`);
  const play = html2.indexOf('<tr class="scPlay"');
  ok(
    row >= 0 && play > row && /data-playkind="playground"/.test(html2),
    'a Playground clip — which has no chapters at all — gets the same inline player',
  );
}

// Stop clears the lot, and the row goes with it.
sandbox.scStop();
ok(
  sandbox.scLib.playing === null && sandbox.scLib.auKey === null && !/class="scPlay"/.test(sandbox.$('scList').innerHTML),
  'Stop drops the player and its row — that IS the way to put the bar away',
);

sandbox.scLib.open = null;
sandbox.scLib.chap = {};

// ══ 6.1-m1b — staging edits on a scene ══════════════════════════════════════════════════
sandbox.scLib.items = [RAW, PG];
sandbox.scLib.open = RAW.ref;
sandbox.scLib.chap[RAW.ref] = [
  { offset_s: 0, character: 'Test Character 1', text: 'the first line' },
  { offset_s: 4.7, character: 'Test Character 2', text: 'the second line' },
  { offset_s: 9.4, character: 'Test Character 1', text: 'the third line' },
];

// 🔴 The staged plan is rendered as the RUNNING ORDER he will get — inserts spliced in at their
// targets, not listed in a separate tray. That is the whole point of staging rather than applying
// one at a time, and it is pure function, so it is checked here rather than in a browser.
sandbox.scLib.edits[RAW.ref] = [
  { op: 'insert_before', index: 0, kind: 'playground', ref: 'v/intro', name: 'An intro' },
  { op: 'replace', index: 1, kind: 'playground', ref: 'v/fix', name: 'A better take' },
  { op: 'insert_after', index: 2, kind: 'playground', ref: 'v/outro', name: 'An outro' },
];
{
  const rows = sandbox.scChapterRows(RAW.ref);
  const shape = rows.map(r => (r.ins ? `+${r.ins.op}` : r.rep ? `rep${r.i}` : `orig${r.i}`));
  ok(
    shape.join(' ') === '+insert_before orig0 rep1 orig2 +insert_after',
    `staged inserts are spliced into the running order (${shape.join(' ')})`,
  );
}

sandbox.renderScenes();
const staged = sandbox.$('scList').innerHTML;
ok(/scStagedRep/.test(staged) && /scStagedIns/.test(staged), 'a replaced line and an inserted one are each marked, and differently');
ok(
  /A better take/.test(staged) && /replaces this line when you Apply/.test(staged),
  'the replaced row says what will replace it, and that nothing has happened yet',
);
ok(/data-unstage="1"/.test(staged), 'every staged edit can be taken back off the plan by its own index');
ok(/id="scEditApply"/.test(staged) && /Apply 3 edits/.test(staged), 'the Apply bar appears with the number of staged edits on it');

// ── the Apply poll has to be able to STOP (8.3) ───────────────────────────────────────────────
//
// 🔴 IT COULD NOT, AND THE PANE STAYED STUCK FOREVER. `scEditPoll` cleared its interval only on a
// terminal `status`; every failed fetch took a bare `catch(e){return;}`. That is right for a blip
// or a 5xx — the next tick retries and the edit carries on — but `scene_edit.JOBS` is IN-MEMORY,
// so a service restart mid-Apply loses the job and `web/clips.py:199` answers 404. Same branch:
// the poll ran every 700 ms for the life of the page while Apply stayed disabled and the status
// line went on saying "Cutting…" about a job that no longer existed. Only a reload escaped it, and
// nothing on screen said so.
//
// ⚠️ BOTH HALVES ARE PINNED BECAUSE FIXING ONE BREAKS THE OTHER. Clearing on ANY error would make
// a two-second network blip abandon a running edit — strictly worse than the bug. The 404 is the
// only terminal case.
//
// 📌 Sliced with `sliceDef`, so the haystack is this one function and the ordering inside the
// catch is what is asserted — not "these words appear somewhere in the file".
{
  const poll = sliceDef('function scEditPoll');
  ok(
    /catch\s*\(\s*e\s*\)\s*\{[\s\S]*?status\s*===\s*404[\s\S]*?clearInterval\(\s*tick\s*\)/.test(poll),
    'a 404 (the job is gone — the server restarted) CLEARS the poll',
  );
  ok(
    /if\s*\(\s*!\s*\(\s*e\s*&&[\s\S]{0,80}?status\s*===\s*404\s*\)\s*\)\s*return\s*;/.test(poll),
    'any other error returns early and keeps polling — a blip must not abandon a live edit',
  );
  ok(
    /status\s*===\s*404[\s\S]*?scEditApply[\s\S]*?disabled\s*=\s*false/.test(poll),
    'and it re-enables Apply, so the pane is usable again without a reload',
  );
  ok(!/scLib\.editTick/.test(poll), 'the interval handle is a local, not dead state on scLib that nothing ever read');
}

// 🔴 A CLASS IS NOT A STYLE. 6.0 §2.3 shipped a rail that computed to `none` because the class
// was asserted and the rule was not there. These are our own stylesheet rather than SillyTavern's,
// so a computed-style test would need a browser for very little — but the RULE existing at all is
// checkable here, and that is the half that was missing last time.
for (const cls of ['scStagedRep', 'scStagedIns']) {
  ok(
    new RegExp(`\\.pgtable tr\\.${cls} td\\{[^}]*background:`).test(html),
    `.${cls} has a real background rule behind it, not just a class name`,
  );
}

// The Apply bar must NOT be there when nothing is staged: a button that does nothing is worse
// than no button on a panel this busy.
sandbox.scLib.edits[RAW.ref] = [];
sandbox.renderScenes();
ok(!/id="scEditApply"/.test(sandbox.$('scList').innerHTML), 'and it is absent while nothing is staged');

// §3.4 — Copy puts (kind, ref) on the clipboard, and the paste buttons appear only once it has
// something on it. Identity is the PAIR, never the ref alone.
ok(!/data-paste=/.test(sandbox.$('scList').innerHTML), 'no paste buttons until something is copied');
sandbox.scLib.clip = { kind: 'playground', ref: 'v/fix', name: 'A better take' };
sandbox.renderScenes();
const pasteable = sandbox.$('scList').innerHTML;
ok(
  /data-paste="insert_before\|0"/.test(pasteable) &&
    /data-paste="replace\|0"/.test(pasteable) &&
    /data-paste="insert_after\|0"/.test(pasteable),
  'with a clip copied, every line offers paste-before, replace and paste-after',
);
ok(/data-pgedit="0"/.test(pasteable), '§3.2: and ✎ Edit in Playground, on a line that has text to load');

// ⚠️ §6 — a JOINED scene's entries have no `text` and no `voice`, so the prefill cannot work.
// Offer Replace/Insert there and hide the prefill, rather than refusing the scene.
sandbox.scLib.chap[RAW.ref] = [{ offset_s: 0, name: 'a joined clip', duration_s: 3 }];
sandbox.renderScenes();
const joined = sandbox.$('scList').innerHTML;
ok(
  !/data-pgedit=/.test(joined) && /data-paste="replace\|0"/.test(joined),
  'a joined scene has no ✎ (nothing to prefill) but is still editable',
);

// §5.2 — an inserted entry has no mesid, and the Chapters list needs a row shape that renders
// without one. This is the single place in the feature where existing UI had to CHANGE.
sandbox.scLib.chap[RAW.ref] = [{ offset_s: 0, mesid: null, inserted: true, text: 'a line he wrote himself' }];
sandbox.renderScenes();
ok(
  /inserted/.test(sandbox.$('scList').innerHTML) && /a line he wrote himself/.test(sandbox.$('scList').innerHTML),
  'an inserted entry with a null mesid still renders as a chapter row',
);

sandbox.scLib.open = null;
sandbox.scLib.clip = null;
sandbox.scLib.edits = {};
sandbox.scLib.chap = {};

// ── 6.3 — Enhance, on the row ────────────────────────────────────────────────
//
// The button must be offered where it can do something, and 7.5.1 changed what that means. It
// used to be hidden on a twin and on a scene that HAS one, mirroring two server refusals — and
// both sides were reading a BOOKKEEPING FLAG rather than the audio.
//
// 🔴 The control remains available when a bookkeeping flag is stale, while the server still refuses
// a genuinely full-band scene based on a measurement (`enhance.is_band_limited`). The answer carries
// the bandwidth it found.
sandbox.scLib.items = [RAW];
sandbox.renderScenes();
ok(/data-act="enhance" data-ref="ferry_ab12cd34"/.test(sandbox.$('scList').innerHTML), 'a raw scene with no twin offers Enhance');

sandbox.scLib.items = [RAW, ENH];
sandbox.renderScenes();
{
  const rows = sandbox
    .$('scList')
    .innerHTML.split('<tr')
    .filter(r => /data-ref="ferry_/.test(r));
  const rawRow = rows.find(r => /data-ref="ferry_ab12cd34"/.test(r)) || '';
  const enhRow = rows.find(r => /data-ref="ferry_enhanced_ff00ff00"/.test(r)) || '';
  ok(
    /data-act="enhance"/.test(rawRow),
    '🔴 a scene that already HAS a twin still offers Enhance — THIS is the one that was hidden ' +
      'by the twin whose accuracy was in doubt',
  );
  // ⚠️ THE ENHANCED TWIN ITSELF DOES NOT OFFER ENHANCE.
  // "why do I see enhance on a clip? It's already enhanced. I didn't expect that." The server's
  // answer there is "already full quality" essentially every time, so the button was a 409 with
  // a delay in front of it — the exact shape 6.3 built this cell to avoid. The question it was
  // asking is answered passively by the size ratio in the Length tooltip, with no click.
  ok(!/data-act="enhance"/.test(enhRow), 'but the enhanced take does NOT — a verb is offered only where it can do something');
  // 🔴 AND THE RAW'S TOOLTIP SAYS **REPLACES**, WHICH IS THE OPPOSITE OF WHAT IT FIRST SAID.
  // The draft promised "ANOTHER one beside it — nothing is overwritten". False: `scene_hash`
  // folds the RAW scene's `created` and `nonce`, not fresh ones, so the same scene at the same
  // `nfe` computes the same H8 and the atomic `encode_mp3` lands on the existing twin. Right
  // behavior, wrong sentence — and "nothing is overwritten" is exactly the sort of promise
  // someone acts on. Pinned here so the words cannot drift back.
  ok(
    /REPLACES it/.test(rawRow) && /this raw scene is untouched/.test(rawRow),
    'and the raw\'s says a re-enhance REPLACES the twin — not the false "nothing is overwritten"',
  );
  ok(!/nothing is overwritten/.test(rawRow), '…and the promise it must never make again is absent');
}

// ── 7.5.1 — the size on the row, and the ratio that answers "did it finish?" ──
//
// 🔴 A twin's `total_duration_s` was INHERITED from its parent's manifest, so the Length column
// printed the raw's length for the twin whatever the twin held — the one column that could have
// shown a cut-short enhancement, reporting the number it could not know. `scene_enhance` measures
// it now; SIZE is what settles the twins already on disk, being the only field on this row taken
// from the file itself (`vault_fs.stat` — the LOGICAL size, per `list_scenes`).
{
  sandbox.scLib.items = [RAW, ENH];
  sandbox.renderScenes();
  const html = sandbox.$('scList').innerHTML;
  ok(/33120000B/.test(html) && /88320000B/.test(html), 'every row shows its size beside its length');
  // 88,320,000 / 33,120,000 = 2.667 — exactly 256/96, i.e. a complete enhancement.
  ok(
    /2\.67× its raw take/.test(html) && /ran the whole way through/.test(html),
    'a twin that is 2.67× its raw take is reported as having run the whole way through',
  );
  // The same twin cut off at ~20 of 74 minutes: smaller than its own parent, and it must SAY so.
  sandbox.scLib.items = [RAW, { ...ENH, size: 38_000_000 }];
  sandbox.renderScenes();
  const short = sandbox.$('scList').innerHTML;
  ok(
    /CUT SHORT/.test(short) && /1\.15×/.test(short),
    '🔴 …and a twin at 1.15× is called out as CUT SHORT',
  );
  // ⚠️ The comparison is only meaningful against the parent it NAMES. A twin whose raw scene has
  // been deleted must say nothing rather than compare itself with whatever is next in the list.
  sandbox.scLib.items = [{ ...ENH, size: 38_000_000 }];
  sandbox.renderScenes();
  ok(!/CUT SHORT/.test(sandbox.$('scList').innerHTML), 'an orphaned twin makes no claim at all — there is nothing to compare it with');
}

// While one is running the row says so and offers a stop.
sandbox.scLib.items = [RAW];
sandbox.scLib.enh = { ferry_ab12cd34: { job: 'j1', text: 'Enhancing on cuda:0 - about 2 min...' } };
sandbox.renderScenes();
{
  const html = sandbox.$('scList').innerHTML;
  ok(/Enhancing on cuda:0/.test(html) && !/data-act="enhance"/.test(html), 'a running enhancement replaces the button with its own status');
  ok(/data-act="enhcancel"/.test(html), 'and a way to stop it');
}
sandbox.scLib.enh = {};

// 🔴 A box that cannot enhance must not OFFER it. Cards can be unticked in Settings, and the enhancer
// needs one of them, so the
// route would answer 400 for a reason nothing on screen explains. That is the shape of all four
// 6.0 defects: the UI promising what the server does not keep.
sandbox.enh.ok = false;
sandbox.enh.msg = 'Enhancing has no card to run on.';
sandbox.scLib.items = [RAW];
sandbox.renderScenes();
ok(!/data-act="enhance"/.test(sandbox.$('scList').innerHTML), 'a box that cannot enhance does not offer the button at all');
ok(/Enhancing has no card/.test(sandbox.$('scList').innerHTML), 'and it says why, where the button would have been');
sandbox.enh.ok = true;

// ── 6.2 — the star, and the filter that is ADDITIVE to the other two ─────────
//
// The favorite filter is additive to the kind and enhancement filters; all three narrow together.
sandbox.scLib.items = [{ ...RAW, favorite: true }, ENH];
sandbox.$('scFavOnly').checked = false;
sandbox.renderScenes();
{
  const html = sandbox.$('scList').innerHTML;
  ok(/data-act="fav" data-ref="ferry_ab12cd34"/.test(html), 'every row carries a star toggle');
  ok(/★/.test(html) && /☆/.test(html), 'a starred row and an unstarred one look different');
}

sandbox.$('scFavOnly').checked = true;
ok(
  sandbox
    .scFiltered()
    .map(s => s.ref)
    .join() === 'ferry_ab12cd34',
  'favorites only leaves exactly the starred rows',
);

// …and it stacks with the enhanced filter rather than replacing it: starred AND enhanced is
// empty here, which is the property that would break if either filter overwrote the other.
sandbox.$('scEnhFilter').value = '1';
ok(sandbox.scFiltered().length === 0, 'the favorites filter ADDS to the enhanced one — starred and enhanced is empty here');
sandbox.$('scEnhFilter').value = '';
sandbox.$('scFavOnly').checked = false;

// ── 11.2.7 — the queue lives on the SERVER; the tab only sends changes to it ──────────────────
//
// 🔴 The server owns the enhancement queue so it continues after the tab closes. The tab should
// only submit requests and must never start an enhancement itself.
//
// ⚠️ WHAT MOVED WITH IT. The 9.0.13 checks that lived here — "two eligible cards ⇒ two starts at
// once", "the first two in ask order", "no ref re-offered while its start is in flight" — are the
// SERVER pump's contract now, and `tests/test_scene_enhance_queue.py` holds them. What is left for
// the tab is that it never starts an enhancement itself, and that one press is one request.
{
  /** @type {{url: string, body: any}[]} */
  const posts = [];
  const box = mkSandbox({
    enh: { ok: true, msg: '', cards: 2 },
    jpost: async (url, body) => (
      posts.push({ url, body }),
      { queue: ['one_aaaa1111'], starting: [], failed: {}, wait: '', done: 0, limit: 2 }
    ),
  });
  box.scEnhQueue('one_aaaa1111');
  ok(
    posts.length === 1 && /\/clips\/scenes\/enhance\/queue$/.test(posts[0].url),
    `a press is ONE request, to the server's queue (${posts.map(p => p.url).join(', ')})`,
  );
  ok(JSON.stringify(posts[0] && posts[0].body) === JSON.stringify({ add: ['one_aaaa1111'] }), '…and it asks the server to ADD the scene');
  ok(
    !posts.some(p => /\/enhance$/.test(p.url) && !/queue/.test(p.url)),
    '🔴 the tab never POSTs a start itself — the server starts every scene',
  );
  ok(box.scLib.enhQ.includes('one_aaaa1111'), 'the row shows as waiting at once, before the server answers');

  box.scEnhApply({ queue: ['one_aaaa1111', 'two_bbbb2222'], starting: [], failed: {}, wait: '', done: 0, limit: 2 });
  ok(/2 at a time, one per card/.test(box.scEnhStrip()), "the strip's fan-out count is the SERVER's card count");
  box.scEnhApply({ queue: ['one_aaaa1111'], starting: [], failed: {}, wait: '', done: 0, limit: 1 });
  ok(!/at a time, one per card/.test(box.scEnhStrip()), '…and a one-card box says nothing about fan-out, because there is none');
  ok(!/leave it open|runs in this tab/.test(box.scEnhStrip()), '🔴 and the strip no longer tells him to keep the tab open');
}
{
  // 🔴 A POLL THAT CHANGED NOTHING DOES NOT REPAINT — `renderScenes` replaces the whole table, so a
  // repaint every 2 s would throw away an inline rename mid-word. But a change HE made always
  // repaints with the server's answer, even when that answer equals the state before his guess.
  const Q = { queue: ['a_aaaa1111'], starting: [], failed: {}, wait: '', done: 0, limit: 1 };
  const box = mkSandbox({
    jget: async () => ({ jobs: [], queue: Q }),
    // The server answers with the state from BEFORE the guess — e.g. an add it skipped.
    jpost: async () => Q,
  });
  box.scLib.items = [{ kind: 'scene', enhanced: false, ref: 'a_aaaa1111', name: 'Alpha' }];
  await box.scEnhSync();
  box.$('scList').innerHTML = 'MARK';
  await box.scEnhSync();
  ok(box.$('scList').innerHTML === 'MARK', 'a sync whose answer did not change leaves the table alone');
  box.scEnhClear(); // paints its optimistic guess (an empty queue) at once…
  box.$('scList').innerHTML = 'MARK'; // …then the server's answer arrives
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  ok(box.$('scList').innerHTML !== 'MARK', "🔴 a change he made always repaints with the server's answer");
}
{
  // The bulk verb is ONE request carrying every ref, in tick order — not one per row.
  /** @type {any[]} */
  const bodies = [];
  const box = mkSandbox({ jpost: async (_u, body) => (bodies.push(body), {}) });
  box.scLib.items = [
    { kind: 'scene', enhanced: false, ref: 'a_aaaa1111', name: 'A' },
    { kind: 'scene', enhanced: false, ref: 'b_bbbb2222', name: 'B' },
  ];
  box.scLib.sel = box.scLib.items.slice();
  box.scEnhSelected();
  ok(
    bodies.length === 1 && JSON.stringify(bodies[0]) === JSON.stringify({ add: ['a_aaaa1111', 'b_bbbb2222'] }),
    `✨ Enhance selected sends one {add} in tick order (${JSON.stringify(bodies)})`,
  );
}
{
  // 🔴 THE ONE-TIME MIGRATION. A browser that held a queue in ui-state before 11.2.7 hands it to the
  // server once — only the refs still listed as raw scenes — and clears the key so it never re-adds.
  const written = { 'vocalis-sc-enhq': JSON.stringify(['a_aaaa1111', 'gone_zzzz9999', 'twin_cccc3333']) };
  /** @type {any[]} */
  const bodies = [];
  const box = mkSandbox({
    UIS: { getItem: k => written[k] || null, setItem: (k, v) => (written[k] = v) },
    jpost: async (_u, body) => (bodies.push(body), {}),
  });
  box.scLib.items = [
    { kind: 'scene', enhanced: false, ref: 'a_aaaa1111', name: 'A' },
    { kind: 'scene', enhanced: true, ref: 'twin_cccc3333', name: 'C' },
  ];
  box.scEnhRestore();
  ok(
    JSON.stringify(bodies) === JSON.stringify([{ add: ['a_aaaa1111'] }]),
    `a queue left in the browser is handed to the server, live raw scenes only (${JSON.stringify(bodies)})`,
  );
  ok(written['vocalis-sc-enhq'] === '[]', '…and the browser copy is cleared, so it is handed over exactly once');
}

// ── 9.2.1: the progress bar, driven THROUGH THE POLL ────────────────────────────────────────────
//
// The progress display is driven by status updates from the real poll path.
//
// 🔴 DRIVEN THROUGH `scEnhPoll`, NOT BY CALLING THE TICK. The defect was not that the arithmetic
// was wrong — there was no arithmetic. It was that the poll RETURNED on every non-terminal status
// and threw the payload away, so a test that called the tick directly would pass against the
// broken code. `setInterval` is stubbed to hand the callback back instead of scheduling it, which
// is what makes the real poll body reachable and keeps the run deterministic.
{
  /** @type {{poll?: () => Promise<void>, status?: object}} */
  const held = {};
  const box = mkSandbox({
    setInterval: fn => ((held.poll = fn), 7),
    jget: async () => held.status,
  });
  const REF = 'one_aaaa1111';
  box.scLib.enh[REF] = { job: 'j1', text: 'Enhancing…', pct: null };
  held.status = { status: 'enhancing', phase: 'enhancing', est_s: 480, elapsed_s: 240 };
  box.scEnhPoll(REF, 'j1');
  await held.poll();
  ok(box.scLib.enh[REF].pct === 50, `halfway through the estimate is a bar at 50% (${box.scLib.enh[REF].pct})`);
  ok(box.$(`enht-${REF}`).textContent === 'Enhancing — 4m of ~8m', `and the row says both numbers (${box.$(`enht-${REF}`).textContent})`);

  // 🔴 The estimate is an average and a slow run overruns it. A bar at 100% on a job that is
  // still going is a worse lie than one at 99% that says why.
  held.status = { status: 'enhancing', phase: 'enhancing', est_s: 480, elapsed_s: 900 };
  await held.poll();
  ok(box.scLib.enh[REF].pct === 99, `an overrun holds at 99, never 100 (${box.scLib.enh[REF].pct})`);
  ok(/taking longer than the estimate/.test(box.$(`enht-${REF}`).textContent), '…and the row says it is taking longer');

  // 🔴 `enhance.estimate_seconds`: "NONE IS A REAL ANSWER AND CALLERS MUST RENDER IT." A box that
  // has never been timed gets a sweep, not a made-up percentage.
  held.status = { status: 'enhancing', phase: 'enhancing', est_s: null, elapsed_s: 30 };
  await held.poll();
  ok(box.scLib.enh[REF].pct === null, 'an untimed box gets an indeterminate sweep rather than an invented percentage');
  ok(/never been timed/.test(box.$(`enht-${REF}`).textContent), '…and says so in words as well');

  // The first ~131 s is the model load. A bar at zero next to "Decoding the scene…" reads as what
  // it is; a bar at zero next to nothing reads as stuck.
  held.status = { status: 'enhancing', phase: 'decoding', est_s: 480, elapsed_s: null };
  await held.poll();
  ok(/Decoding the scene/.test(box.$(`enht-${REF}`).textContent), 'the phase is what the row shows before there is anything to divide');
  ok(box.scLib.enh[REF].pct === null, '…and there is no fraction until the enhancer has started');
}

// ── 9.2.1: the strip counts the batch, and one control stops it ─────────────────────────────────
{
  const box = mkSandbox({ enh: { ok: true, msg: '', cards: 1 } });
  box.scLib.enh['a_aaaa1111'] = { job: 'j1', text: 'x', pct: 10 };
  box.scLib.enhDone = 3;
  const strip = box.scEnhStrip();
  ok(/1 running/.test(strip) && /3 done/.test(strip), `the strip counts running and done, not only waiting (${strip.slice(0, 120)})`);
  ok(/Stop everything/.test(strip), 'and it offers ONE control that stops the lot');
  ok(/class="bar"/.test(box.scEnhLive('a_aaaa1111', box.scLib.enh['a_aaaa1111'])), 'a running row renders an actual bar element');
}
{
  /** @type {string[]} */
  /** @type {{url: string, body: any}[]} */
  const posts = [];
  const box = mkSandbox({
    jpost: async (url, body) => (posts.push({ url, body }), {}),
    modal: async () => 1,
  });
  box.scLib.enhQ = ['b_bbbb2222'];
  box.scLib.enh['a_aaaa1111'] = { job: 'j1', text: 'x', pct: 10 };
  await box.scEnhStopAll();
  ok(box.scLib.enhQ.length === 0, 'Stop everything empties the queue');
  // 11.2.7 — both halves are one server call now: `stop_all` empties the queue, then cancels.
  ok(
    posts.some(p => /enhance\/queue$/.test(p.url) && p.body && p.body.stop === true),
    'AND asks the server to cancel what is already running — the half `Clear` deliberately does not do',
  );
}
{
  /** @type {string[]} */
  const posts = [];
  const box = mkSandbox({ jpost: async url => (posts.push(url), {}), modal: async () => 0 });
  box.scLib.enhQ = ['b_bbbb2222'];
  box.scLib.enh['a_aaaa1111'] = { job: 'j1', text: 'x', pct: 10 };
  await box.scEnhStopAll();
  ok(posts.length === 0 && box.scLib.enhQ.length === 1, 'declining the confirmation leaves the queue AND the running job alone');
}

// ── 9.2.2: ✨ Enhance selected ───────────────────────────────────────────────────────────────────
//
// The bulk action adds eligible selected clips to the enhancement queue.
//
// 🔴 THE COUNT ON THE BUTTON IS WHAT WOULD ACTUALLY BE ADDED, which is not the number of ticked
// rows. A selection routinely holds twins, Playground clips and scenes already queued from the
// row button, and a button that counted those would say "(5)" and add two — the exact shape of
// every defect this tab has had.
{
  const box = mkSandbox({ enh: { ok: true, msg: '', cards: 1 } });
  const RAWS = { kind: 'scene', enhanced: false };
  box.scLib.items = [
    { ...RAWS, ref: 'a_aaaa1111', name: 'A' },
    { ...RAWS, ref: 'b_bbbb2222', name: 'B' },
    { kind: 'scene', enhanced: true, ref: 'twin_cccc3333', name: 'C (a twin)' },
    { kind: 'clip', enhanced: false, ref: 'pg_dddd4444', name: 'D (a Playground clip)' },
  ];
  box.scLib.sel = box.scLib.items.slice(); // all four ticked
  box.scLib.enhQ = ['b_bbbb2222']; // …and one of them is already waiting
  ok(
    box.scEnhSelectable().length === 1 && box.scEnhSelectable()[0].ref === 'a_aaaa1111',
    `only the raw scene that is not already queued counts (${box
      .scEnhSelectable()
      .map(s => s.ref)
      .join(',')})`,
  );
  box.scSyncSel();
  ok(/\(1\)/.test(box.$('scEnhSel').textContent), `the button says how many it would add (${box.$('scEnhSel').textContent})`);
  ok(box.$('scEnhSel').disabled === false, 'and it is enabled while there is one to add');

  ok(box.scEnhSelected() === 1, 'pressing it queues exactly those');
  ok(box.scLib.enhQ.includes('a_aaaa1111'), '…by the same path as the row button, so the queue keeps ONE definition of "queued"');
  ok(!box.scLib.enhQ.includes('twin_cccc3333') && !box.scLib.enhQ.includes('pg_dddd4444'), 'a twin and a Playground clip are never queued');
  box.scSyncSel();
  ok(box.$('scEnhSel').disabled === true, 'and the button disables itself once everything ticked is queued — a second press is a no-op');
}
{
  // 🔴 A BOX THAT CANNOT ENHANCE IS NOT OFFERED IT — the same refusal `scEnhCell` makes on the
  // row. If no enhancement cards are available, the route would answer 400 for a reason
  // nothing on screen explains.
  const box = mkSandbox({ enh: { ok: false, msg: 'no card', cards: 0 } });
  box.scLib.items = [{ kind: 'scene', enhanced: false, ref: 'a_aaaa1111', name: 'A' }];
  box.scLib.sel = box.scLib.items.slice();
  ok(box.scEnhSelectable().length === 0, 'a box that cannot enhance offers nothing to bulk-enhance');
  box.scSyncSel();
  ok(box.$('scEnhSel').disabled === true, '…and the button stays disabled and unnumbered');
}

// 🔴 THE WIRING, AT TWO LAYERS. A handler nobody calls and a button nothing wires look identical
// from either side on its own — `scEnhSelected` is exercised above, so what is left to prove is
// that a press reaches it. The button is in the PAGE (a partial, expanded by readPage) and the
// wiring is in the MODULE, outside the vm slice, so each is asserted where it lives.
ok(/id="scEnhSel"/.test(html), 'the page carries the ✨ Enhance selected button');
ok(/\$\('scEnhSel'\)\)?\.onclick/.test(anywhere), "…and something wires that id's onclick");
ok(/scEnhSelected\(\)/.test(anywhere), '…to the function the checks above drive');

// ── 9.5.6: the queue is a LIST, not a drift of pills ────────────────────────────────────────────
//
// The queue renderer presents ordered rows in a scrollable list with a per-item remove control.
// The browser layout spec verifies the visual geometry separately.
//
// ⚠️ WHAT THIS FILE CAN AND CANNOT SEE. It runs the renderer in a bare vm with no CSS, so the
// SHAPE of the markup is checkable here and the LAYOUT is not — `clips_queue_layout_spec.mjs`
// measures the laid-out boxes in a real browser and captures a picture of them. The two answer
// different questions and neither is sufficient: markup with the wrong CSS looks broken, and CSS
// with the wrong markup styles nothing.
{
  const box = mkSandbox({ enh: { ok: true, msg: '', cards: 1 } });
  box.scLib.items = [
    { kind: 'scene', enhanced: false, ref: 'a_aaaa1111', name: 'Alpha' },
    { kind: 'scene', enhanced: false, ref: 'b_bbbb2222', name: 'Bravo' },
    { kind: 'scene', enhanced: false, ref: 'c_cccc3333', name: 'Charlie' },
  ];
  box.scLib.enhQ = ['a_aaaa1111', 'b_bbbb2222', 'c_cccc3333'];
  const strip = box.scEnhStrip();

  // 🔴 THE SQUISH ITSELF, PINNED AS AN ABSENCE. Every header cell carried `style="flex:0"`, which
  // against `.row>div{flex:1 1 150px}` is `flex:0 1 0%` — a basis of ZERO with shrink still on, so
  // the cell was sized by its longest word and the warning stacked eight lines deep. Two things
  // have to be true for that to be unreachable rather than merely fixed: no inline flex anywhere
  // in the strip, and no `.row` ancestor for a future one to fight with.
  ok(/class="scEnhHead"/.test(strip), 'the header is its own flex container');
  ok(!/flex:0/.test(strip), '🔴 and NOTHING in the strip carries an inline flex:0 — that was the squish');
  ok(!/class="row"/.test(strip), '…nor a .row, so the 150px basis rule cannot reach these cells at all');

  // The list itself: one row per waiting item, in queue order, each with its position and its ✕.
  const rows = strip.match(/<div class="scEnhItem"[\s\S]*?<\/div>/g) || [];
  ok(/id="scEnhList"/.test(strip), 'the waiting items live in one scroll box (#scEnhList)');
  ok(rows.length === 3, `one row per waiting item, not one pill (${rows.length})`);
  ok(!/class="pill"/.test(strip), '🔴 and no pills are left — that markup is what wrapped into a ragged block');
  ok(
    rows.every((r, i) => new RegExp(`<span class="scEnhPos">${i + 1}</span>`).test(r)),
    'every row carries its position, which a wrapped pill had nowhere to put',
  );
  ok(
    /data-ref="a_aaaa1111"[\s\S]*data-ref="b_bbbb2222"[\s\S]*data-ref="c_cccc3333"/.test(strip),
    '…and they are in queue order, top to bottom',
  );
  ok(
    rows.every(r => /data-act="enhdequeue"/.test(r) && /class="xs scEnhX"/.test(r)),
    'each row has its own ✕, on the same verb the pill used',
  );
  ok(
    rows.every(r => /draggable="true"/.test(r)),
    'every waiting row is draggable',
  );
  ok(/Alpha<\/span>/.test(strip) && /Bravo<\/span>/.test(strip), 'rows are named by the scene, not by the ref');
  ok(/scEnhState">next</.test(strip), 'the head of the queue says it is next');

  box.scLib.enh['x_xxxx0000'] = { job: 'j0', text: 'x', pct: 5 };
  const s2 = box.scEnhStrip();
  ok(/1 running/.test(s2) && /3 waiting/.test(s2), 'the header still counts running and waiting side by side');
  delete box.scLib.enh['x_xxxx0000'];
}

// 🔴 A ROW WHOSE START IS IN FLIGHT IS NOT DRAGGABLE, and this is the state the old ⏳ blurred.
// It wore the same mark as "merely first in line", and the two differ in what a gesture on them can
// achieve: the server's pump is already starting it, so moving it changes nothing. A gesture
// accepted and then ignored is worse than one refused.
//
// 📌 11.2.7: "starting" is the SERVER's word now (`starting` in its snapshot), so this is driven by
// the snapshot the tab receives, which is exactly the path a real sync takes.
{
  const box = mkSandbox({ enh: { ok: true, msg: '', cards: 1 } });
  box.scLib.items = [
    { kind: 'scene', enhanced: false, ref: 'a_aaaa1111', name: 'Alpha' },
    { kind: 'scene', enhanced: false, ref: 'b_bbbb2222', name: 'Bravo' },
  ];
  box.scEnhApply({ queue: ['a_aaaa1111', 'b_bbbb2222'], starting: ['a_aaaa1111'], failed: {}, wait: '', done: 0, limit: 1 });
  const strip = box.scEnhStrip();
  const rowOf = ref => (strip.match(new RegExp(`<div class="scEnhItem" data-ref="${ref}"[\\s\\S]*?</div>`)) || [''])[0];
  ok(/starting/.test(rowOf('a_aaaa1111')), `the ref the server is starting says so (${rowOf('a_aaaa1111').slice(0, 90)})`);
  ok(/draggable="false"/.test(rowOf('a_aaaa1111')), '🔴 …and it refuses the drag rather than accepting one that would do nothing');
  ok(/draggable="true"/.test(rowOf('b_bbbb2222')), 'the one still waiting behind it is draggable');
  ok(!/scEnhState">next</.test(strip), '…and nothing claims to be "next" while a start is actually in flight');
}

// ── 9.5.6: reordering ──────────────────────────────────────────────────────────────────────────
//
// 🔴 STATED AS "BEFORE WHICH REF", NOT AS AN INDEX, and these checks are why. An index computed
// against the list on screen is wrong the moment the moved item is spliced out of it — dragging
// row 2 to row 5 is index 5 while it is still there and index 4 once it is gone — so a
// same-direction test would pass while the other direction landed one place short.
{
  /** @type {any[]} */
  const bodies = [];
  const box = mkSandbox({
    enh: { ok: true, msg: '', cards: 0 },
    jpost: async (_u, body) => (bodies.push(body), {}),
  });
  box.scLib.enhQ = ['a', 'b', 'c', 'd'];
  const order = () => box.scLib.enhQ.join('');

  ok(box.scEnhMove('d', 'a') === true && order() === 'dabc', `last to first (${order()})`);
  ok(box.scEnhMove('d', null) === true && order() === 'abcd', `…and back to the end, which null names (${order()})`);
  // 🔴 THE DOWNWARD MOVE IS THE ONE AN INDEX GETS WRONG. 'a' before 'd' means abc, then insert at
  // d's place: bcad. An index read off the rendered list would have said 3 and given bcda.
  ok(box.scEnhMove('a', 'd') === true && order() === 'bcad', `🔴 downward: a lands immediately before d (${order()})`);
  ok(box.scEnhMove('a', 'a') === false && order() === 'bcad', 'dropping a row onto itself changes nothing and says so');
  ok(box.scEnhMove('a', 'd') === false && order() === 'bcad', '…and so does dropping it back exactly where it already sits');
  ok(box.scEnhMove('zz', 'b') === false && order() === 'bcad', 'a ref that is not in the queue is refused, not appended');
  ok(box.scEnhMove('b', 'zz') === true && order() === 'cadb', 'an unknown destination means the end rather than a lost row');

  // 🔴 THE ORDER IS PART OF THE QUEUE, SO IT SURVIVES A RELOAD. A reorder that only lived in the
  // DOM would look right until he refreshed at midnight and got his original order back. 11.2.7:
  // the server keeps the order, so every real move is sent to it — in the same "before which ref"
  // form — and a refused move sends nothing.
  ok(bodies.length === 4, `each of the four real moves is sent to the server, and the three refusals are not (${bodies.length})`);
  ok(
    JSON.stringify(bodies[bodies.length - 1]) === JSON.stringify({ move: 'b', before: 'zz' }),
    `…as "move this before that" (${JSON.stringify(bodies[bodies.length - 1])})`,
  );
}

// ── 9.5.6: a live drag owns the DOM until it ends ───────────────────────────────────────────────
//
// 🔴 `renderScenes` REPLACES ALL OF `#scList`, so a render landing mid-gesture destroys the element
// under the cursor: the drag dies with no drop event, no error and nothing on screen to explain it.
// `ui/folders.js` records the same hazard for the poll-driven lists and answers it by skipping the
// tick — safe there, because another tick is 2 s away. Nothing follows this render, so it has to
// be REMEMBERED and flushed, and that difference is what these checks are about.
{
  const box = mkSandbox({ enh: { ok: true, msg: '', cards: 0 } });
  box.scLib.items = [{ kind: 'scene', enhanced: false, ref: 'a_aaaa1111', name: 'Alpha' }];
  box.scLib.enhQ = ['a_aaaa1111'];

  box.renderScenes();
  ok(/scEnhItem/.test(box.$('scList').innerHTML), 'precondition: an ordinary render paints the queue box');

  box.scEnhDragBegin('a_aaaa1111');
  box.$('scList').innerHTML = 'UNTOUCHED';
  box.renderScenes();
  ok(box.$('scList').innerHTML === 'UNTOUCHED', '🔴 a render arriving mid-drag does not replace the list under the cursor');

  box.scEnhDragEnd();
  ok(/scEnhItem/.test(box.$('scList').innerHTML), '…and the render it skipped is flushed when the drag ends, not dropped');

  // A dragend with nothing deferred must not paint either — the flush is for a render that was
  // actually refused, and an unconditional one would repaint on every abandoned gesture.
  box.$('scList').innerHTML = 'STILL UNTOUCHED';
  box.scEnhDragEnd();
  ok(box.$('scList').innerHTML === 'STILL UNTOUCHED', 'a drag that ended with no deferred render repaints nothing');
}

// 🔴 THE GESTURE IS WIRED, AND AT THE LAYER IT LIVES IN. `scEnhMove` and the guard are exercised
// above inside the vm; the handlers that call them are BELOW the slice (they need a document), so
// what is left to prove is that they exist and reach these functions. A reorder function nobody
// calls and a handler wired to nothing look identical from either side on its own.
ok(/addEventListener\('dragstart'/.test(anywhere), 'something wires a dragstart on the Clips list');
ok(/addEventListener\('dragover'/.test(anywhere), '…and a dragover');
ok(/addEventListener\('drop'/.test(anywhere), '…and a drop');
ok(/addEventListener\('dragend', scEnhDragClear\)/.test(anywhere), '…and a dragend, which is what makes the repaint guard safe');
ok(/scEnhMove\(moved, before\)/.test(anywhere), '…and the drop commits through scEnhMove');
ok(/scEnhDragBegin\(ref\)/.test(anywhere), '…and the dragstart raises the repaint guard');

// 🔴 Look up the face by SillyTavern's avatar filename. A name-only lookup is ambiguous when
// multiple library documents share a name. Prefer the scene's recorded avatar; older scenes may
// use the Character Voices registry when the name is unique.
{
  const seen = [];
  const box = mkSandbox({
    stSceneFaceFor: (name, avatar) => (seen.push([name, avatar || '']), '<i></i>'),
    jget: async () => ({
      characters: {
        Test_Character_4: { avatar: 'Test_Character_4.png' },
        Test_Character_5: { avatar: 'Test_Character_5.png' },
        Test_Character_5_Alt: { name: 'Test_Character_5', avatar: 'Test_Character_5_Alt.png' },
        Test_Character_6: { voice: 'test_character_6.wav' },
      },
    }),
  });
  await box.scLoadStAvatars();
  box.scFaceFor({ characters: ['Test Character 3'], character_avatars: ['Test Character 3.png'] }, 'Test Character 3');
  box.scFaceFor({ characters: ['Test_Character_4'], character_avatars: [''] }, 'Test_Character_4');
  box.scFaceFor({ characters: ['Test_Character_4'] }, 'Test_Character_4');
  box.scFaceFor({ characters: ['Test_Character_5'] }, 'Test_Character_5');
  box.scFaceFor({ characters: ['Test_Character_6'] }, 'Test_Character_6');
  ok(seen[0][1] === 'Test Character 3.png', "🔴 a scene's recorded avatar is what the face is looked up by");
  ok(seen[1][1] === 'Test_Character_4.png' && seen[2][1] === 'Test_Character_4.png', 'an older scene borrows the avatar from the Character Voices registry');
  ok(seen[3][1] === '', 'a name two SillyTavern characters share is not guessed at — it falls back to the name');
  ok(seen[4][1] === '', 'a registry entry with no avatar falls back to the name');

  const failing = mkSandbox({ jget: async () => Promise.reject(new Error('locked')) });
  let threw = false;
  try {
    await failing.scLoadStAvatars();
  } catch (e) {
    threw = true;
  }
  ok(!threw, 'a failed registry read costs the fallback, never the Clips rows');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
