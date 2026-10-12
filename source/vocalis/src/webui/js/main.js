// main.js — the application's boot sequence (7.3-m2).
//
// This is the `(async()=>{…})()` that used to sit at `index.html:10457`, stranded inside the
// SillyTavern-log section between `$('stLogClear').onclick` and the Character Cards banner,
// because that happened to be the end of the file the day it was written.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WHY THIS MOVED FIRST, WHEN DESIGN_7_3_FRONTEND_SPLIT.md §5 SAID IT MOVES LAST.
//
// §5 ordered this last because it reaches into fifteen areas, so "it can only move when all
// fifteen are modules it can import." That reasoning is circular, and the plan deadlocked on
// it: §3.1b also said none of the eighteen functions this calls may become a module while
// this is still inline — and those eighteen are defined across **14 of the file's 73 banner
// areas**, i.e. most of m3 through m11. Nothing could move until boot moved; boot could not
// move until everything had.
//
// ✅ The deadlock is not real, because §3.1's asymmetry only cuts one way:
//
//     inline → module AT PARSE TIME   impossible — the module has not run. THE hazard.
//     module → inline AT RUNTIME      always works — a module body resolves a global on the
//                                     global scope at CALL time, and a module does not run
//                                     until the whole document has been parsed, by which
//                                     point every inline definition exists.
//
// So this file calls `loadGpus()` while `loadGpus` is still a plain inline function, and that
// is not a transitional hack — it is the normal, specified behavior of the scope chain. As
// each of the 14 areas becomes a module, its name here turns into a real `import` and nothing
// else about this file changes.
//
// 📌 AND MOVING IT IS STRICTLY SAFER THAN LEAVING IT. As inline code this ran DURING parsing,
// so its first call happened before the rest of the script had been read, and every
// continuation after an `await` raced the module tree (§3.1b). As a module it runs once,
// after everything, with no race left to reason about. Measured before the move: there are
// **zero** top-level statements after it in the inline block, so nothing changed order.
// It was already the last thing that ran; now it is the last thing that runs, explicitly.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE TRAP FOR WHOEVER ADDS THE FIRST REAL IMPORT HERE — `import` IS HOISTED.
//
// Every `import` in the shim executes before ANY statement in it, including its
// `Object.assign(window, …)`. So a name that has become a module export is NOT on `window`
// yet while this file's body runs. **Import it properly, from its module, right here.** Never
// reach for a shim-published global — it works for the still-inline names only because those
// were never published by the shim in the first place; they are real globals from a classic
// script. `tests/test_webui_parsetime.py` will not catch this one, because it is not a
// parse-time failure. Nothing will catch it but a browser spec.

// ✅ THE FIRST REAL IMPORTS LANDED IN 7.3-m4, and they are the case the warning above describes.
// loadGpus, loadDevices and loadVoices became js/sys/devices.js, so they are imported here rather
// than read off the shim — which is the rule regardless of whether the shim would have worked.
// (It would: the shim's `await import('/webui/js/main.js')` is dynamic and runs AFTER its
// Object.assign, so these three are on `window` by the time this body executes. That is a
// property of one line in index.html, though, and importing does not depend on it. The other ~16
// names this file calls are still inline globals and still resolve at call time, exactly as the
// asymmetry above says they do; each becomes an import here as its area moves.)
import { $ } from './util/dom.js'; // 7.3-m13: was reached off the shim
import { UIS } from './util/uistate.js'; // 7.3-m13: the last page global
import { loadGpus, loadDevices, loadVoices } from './sys/devices.js';
// 🔴 `switchTab` AND `switchBkTab` BECAME js/ui/tabs.js AT 7.3-m2a, so these are IMPORTS rather than
// reads off the classic script's scope chain. `switchBkTab('library', false)` below enforces the
// Library fallback for a browser that saved the old 'library'/'output' top-level tab, and
// `switchTab(…)` is the last thing the tab restore does.
// ⚠️ THE ORDER NOTE FURTHER DOWN STILL HOLDS AND IS NOW SHARED WITH THAT FILE: this module body sets
// `window.__uiReady` immediately after the shim's `Object.assign`, and the `#tabs` click listener —
// which moved into ui/tabs.js with the function it calls — still defers to it and parks an early
// click in `window.__pendingTab` (§11.6 item 3). Both halves have to keep agreeing about those two
// window properties; they are the one piece of state the tab bar shares across a file boundary.
import { switchTab } from './ui/tabswitch.js'; // 7.5.6 — the leaf, not the hub
import { switchBkTab } from './ui/tabs.js';
import { loadEnhanceInfo } from './sys/enhance.js'; // 7.3-m13: were shim reads
import { pollReady } from './sys/model.js';
import { startIdleVram } from './sys/hwstrip.js';
import { ssResume } from './media/stems.js';
// `stTab` is module-scoped, so use `stTabSet` rather than assigning a new window property. The
// migration records the sub-tab before opening its section; switching inside a hidden section would
// paint and load a pane the user cannot see.
import { stTabSet } from './st/tabstate.js';
import { llmTabSet } from './llm/tabstate.js'; // 9.5-m1, and the same setter-not-switcher rule
// 🔴 THIS IMPORT IS ALSO WHAT WIRES THE #comfyBtn CLICK HANDLER, which is a top-level statement in
// that file — so it is load-bearing beyond the one name. js/sys/comfy.js is NOT on the shim (no
// inline code calls into it), and this is its only importer, so dropping the line does not produce
// a ReferenceError anywhere; it silently produces a ComfyUI button that does nothing.
import { pollComfy } from './sys/comfy.js';
// 🔴 SAME LOAD-BEARING IMPORT, SAME TRAP: `$('aceBtn').onclick` is a top-level statement in
// js/sys/acestep.js, so this line is what wires the button as much as it is what names the poll.
// Drop it and there is no ReferenceError — just an ACE-Step button that does nothing.
import { pollAcestep } from './sys/acestep.js';
// The ACE-Step tab's card rows. Load-bearing for the same reason as the two above: its `change`
// listener and its `onAceStatus` subscription are top-level statements, so importing the file IS
// what wires the rows. It exports `paintAceCards` only so the name is not a bare side-effect
// import that a tidy-up would delete.
import './ace/cards.js';
// The song form and its template picker. Same load-bearing-import rule: its button handlers are
// top-level statements. `loadAceTemplates` is awaited by the boot chain below rather than fired
// here, so the picker is populated before the tab can be opened.
import { loadAceTemplates, loadAceRefs, loadAceSources } from './ace/form.js';
// The candidates tray and the song library. Load-bearing import again — it paints its own markup
// at module load and its click handler is delegated off `document` at the top level.
import { startAceTray } from './ace/tray.js';
// The Advanced section. Painted at module load like its neighbors; `form.js` imports
// `readAceAdvanced` from it directly, so this line is about the PAINT, not the name.
import './ace/advanced.js';
// ✅ 7.3-m6a. `parseBook` is the bare-value wiring below; `loadRenderRate` is awaited by the boot
// IIFE. Both were inline globals until this commit and are imported here rather than read off the
// shim, per the rule at the top of this file — not because the shim would fail (it would work: the
// shim's `await import('./main.js')` is dynamic and runs after its Object.assign) but because
// depending on that ordering is depending on one line of index.html staying where it is.
import { parseBook, loadRenderRate } from './book/parse.js';
// ✅ 7.3-m6b. Both are awaited by the boot IIFE below, in that order, and `restoreBook` has to come
// after `loadEnhanceInfo` because selecting a book quotes an enhance ETA — see the note down there.
// ⚠️ This import is ALSO what wires #bookSelect / #bookRefresh / #bookUpload / #bookDelete, which
// books.js attaches at module load. That makes it load-bearing beyond these two names, and it is
// the reason index.html's shim keeps its own copy of the line: the shelf must be wired on any page
// that has the markup, not only on one that got as far as booting.
import { loadBooks, restoreBook } from './book/books.js';
// ✅ 7.3-m6c, and this file is book/job.js's ONLY importer — it is deliberately not on the shim,
// because nine of its twelve names have no reference outside it and these three are wired here.
// `runBook` and `cancelJob` are the two bare-value wirings below; `resumeRender` is the last thing
// boot awaits. With this line the wiring block below finally names nothing that is still inline.
import { runBook, cancelJob, resumeRender } from './book/job.js';
import { pgLibLoad } from './pg/pgstate.js'; // 7.5.6 — was `loadPgLib` from playground.js
// ✅ 7.3-m12b. The boot IIFE awaits `loadAppSettings` below, and it is imported rather than read
// off the shim per the rule at the top of this file. ⚠️ It lives in ui/theme.js because it shares
// `uiFontTouched` with the slider — a stale-response guard, not a filing accident; that module's
// header has the argument.
import { loadAppSettings } from './ui/theme.js';
// 🔴 7.3-m12c — AN IMPORT FOR ORDER, NOT FOR A NAME, and the only one in this file. The two
// `$('refreshVoices').onclick` / `$('pgRefresh').onclick` statements below address ids that
// `voiceClusterHTML` PAINTS, and that paint is now a module body rather than a parse-time
// statement. This line makes "voicepicker first" a property of the import graph.
//
// ⚠️ It would work without the line — the shim reaches this file through a *dynamic*
// `await import()` that runs after every static import, including voicepicker's (§11.3). But that
// is a fact about one line of index.html, and the whole reason m12c uses import edges for this
// ordering is that index.html is what m13 deletes. `stepVoice` is the name because it is the one
// this file could plausibly want; the import is load-bearing for the paint either way.
import { stepVoice } from './ui/voicepicker.js'; // eslint-disable-line no-unused-vars

// ═════════════════════════════════════════════════════════════════════════════════════════
// 🔴 THE MODULE GRAPH'S ROOT — 7.3-m13, AND THIS BLOCK IS WHAT REPLACED `Object.assign(window, …)`.
//
// index.html carried a `<script type="module">` that imported ~50 modules as `import * as xMod`
// and flattened them all onto `window`, so the shrinking classic script could keep calling them.
// §10 items 1 and 2 delete both: the page now has ONE script tag, `<script type="module"
// src="/webui/js/main.js">`, and this file is where the graph is rooted.
//
// ⚠️ THESE IMPORTS ARE FOR SIDE EFFECTS AND THE SIDE EFFECTS ARE THE APPLICATION. Nearly every
// Modules in this list install the retained page's handlers and controls. Modules for excluded
// features are listed in `webui/product-exclusions.json` and are neither bundled nor served.
//
// 📌 ORDER: still none of your business except where an import edge says otherwise. ES modules
// evaluate depth-first over the graph, so a module's dependencies always run before it — which is
// how `ui/voicepicker.js`'s cluster paint is guaranteed to precede the three files that wire the
// ids it paints (m12c), and it is a property of those files' own imports rather than of this list.
// **The one thing this list controls is that every module runs at all.** Keep it alphabetical
// inside each group and do not reason about its order.
import './util/http.js';
import './util/fmt.js';
import './util/filter.js';
import './ui/modal.js';
import './ui/fav.js';
// 7.5.25 — the spacebar must not open a file dialog off a focused `<input type="file">`. Exports
// nothing; the capture-phase listener IS the feature. Read its header before removing it — it is
// the file-picker-opening-by-itself bug, and the cause was not where it looked.
import './ui/filesafe.js';
import './ui/log.js';
// 9.0.8 — the tab bar stays under the header while the page scrolls. Exports nothing; the
// measurement IS the feature, and without this line the tabs silently scroll away again.
import './ui/stickytabs.js';
// 9.0.8 — the `? Help` sections on Productions and LoRA Studio ▸ Subjects. The prose lives in
// the module rather than the partials, because index.html has a line ceiling and this is exactly
// the kind of growth it exists to catch.
// Excluded feature help notes are not part of the product page.
import './ui/theme.js';
import './ui/filterwiring.js'; // the nine filter boxes; exports nothing, and is the feature
import './sys/hwstrip.js';
import './sys/kobold.js';
import './sys/llama.js'; // 9.5-m1
import './llm/tabs.js'; // 9.5-m1 - the LLM sub-tab router; wires #llmTabs at module-eval
import './sys/login.js'; // exports nothing on purpose — applyLogin re-wraps the vault DEK
import './media/bulk.js';
import './media/cleanup.js';
import './media/stemwidget.js';
import './voice/autoplay.js'; // exports nothing — a doubled MutationObserver plays a row twice
import './voice/params.js';
import './media/speech.js';
import './media/stems.js';
import './media/studio-tabs.js';
import './voices/voices.js';
import './st/chars.js';
import './st/log.js';
import './st/nomi.js';
import './st/nomipair.js';
import './st/pairing.js';
import './st/tabs.js';
import './scenes/scenes.js';
import './book/library.js';
import './wb/apply.js';
import './wb/dl.js';
import './wb/edit.js';
import './wb/face.js';
import './wb/fmt.js';
import './wb/kind.js';
import './wb/log.js';
import './wb/open.js';
import './wb/pass.js';
import './wb/prompt.js';
import './wb/say.js';
import './wb/st.js';
import './wb/state.js';
import './wb/wire.js'; // exports nothing — re-importing for a name would re-wire a pane
// ═════════════════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE WIRING BELOW CAME OUT OF index.html's `// ── boot ──` BANNER IN 7.3-m4, AND MOVING IT
// WAS A PREREQUISITE FOR EXTRACTING js/sys/devices.js — not a tidy-up.
//
// `$('refreshVoices').onclick=loadVoices;` names `loadVoices` as a BARE VALUE. A value reference
// is evaluated at PARSE TIME exactly as hard as a call is, so while that line was inline,
// `loadVoices` had to be an inline global — and `loadVoices` is devices code. Extracting devices
// underneath it would have thrown a ReferenceError DURING parsing, killing every top-level
// statement after it, i.e. most of the page.
//
// ⚠️ AND NO TEST WOULD HAVE TOLD YOU. tests/test_webui_parsetime.py's `_names_used` is `_CALL`
// (a name followed by `(`) ∪ `_RECEIVER` (a name followed by `.` or `[`). A bare identifier
// matches neither pattern, so the scanner goes green on exactly this crash. There are 55 such
// sites in index.html; these three were the ones that reached across areas. §3.1a lists the two
// blind spots that were already known — this is the third.
//
// ✅ Here it is safe by the module→inline asymmetry at the top of this file: these are top-level
// statements in a module, so they run after the document is parsed, when parseBook, runBook,
// cancelJob and loadVoices all exist regardless of which of them are still inline. They keep
// their original position ABOVE the boot IIFE, which is where they were in index.html.
//
// ✅ AND AS OF 7.3-m6c NONE OF THE FIVE IS INLINE ANY MORE — parseBook (m6a), runBook/cancelJob
// (m6c) and loadVoices (m4) are all imports above. The asymmetry is what made this block safe to
// move THREE MILESTONES BEFORE the code it names; it is now safe for the duller reason that every
// name is resolved at module-link time. 📌 Which is the argument for moving wiring early rather
// than with its function: the wiring is what pins a name to the page, and once it is out, the
// extraction underneath is mechanical. m6a needed no defusing at all because of this block.
// 📌 They are verbatim, per §6 step 4 — including the trailing comment and its spacing.
/** @type {VEl} */ ($('parseBtn')).onclick = parseBook;
/** @type {VEl} */ ($('path')).addEventListener('keydown', e => {
  if (e.key === 'Enter') parseBook();
});
/** @type {VEl} */ ($('runBtn')).onclick = runBook;
/** @type {VEl} */ ($('cancelBtn')).onclick = cancelJob;
/** @type {VEl} */ ($('refreshVoices')).onclick = loadVoices;
/** @type {VEl} */ ($('pgRefresh')).onclick = loadVoices; // ↻ rescans voices for BOTH selects

// Boot order matters: gpus/voices/settings/books first (resume overrides them with the
// live job's values), then restore the remembered book selection, then reattach to any
// render in progress — the last word on what the page shows belongs to the running job.
// loadDevices is deliberately NOT awaited: it probes every configured satellite, and a satellite
// is usually asleep, so awaiting it would hold the whole page behind a connect timeout to make
// one panel of the ⚙ tab correct a second earlier.
// Keep the migrated block below verbatim: the smoke test checks its saved-tab migration shape.
// Update the assertion in the same change if that block is reformatted.
// 🔴 THE TAB BAR IS CLICKABLE BEFORE THIS FILE EXISTS, AND THAT USED TO THROW (§11.6 item 3).
//
// The listener attaches when js/ui/tabs.js evaluates, before this boot path opens a tab.
//
// `__pendingTab` covers the gap after the tab listener is installed and before this module marks
// the UI ready. Set readiness here so the tab bar is not blocked by the boot fetches below.
window.__uiReady = true;

// 🔴 THREE PHASES, AND THE ORDER IS ABOUT WHAT THE USER IS LOOKING AT (7.5.8).
//
// Requests start together, but the initial paint waits only for the active tab and the header
// controls. Other tab data can finish in the background so those tabs open without another wait.
//
// 📌 EVERY FETCH IS ISSUED AT THE TOP, AT ONCE. Holding a promise is not awaiting it — the
// requests all go out immediately and in parallel, and the `await`s below choose which ones the
// FIRST PAINT is allowed to wait for. Nothing is serialized behind anything it does not need.
// ⚠️ So do not "tidy" these into one Promise.all: the point is that each is separately awaitable.
//
// ⚠️ AND THE HEADER TRIO STILL GOES FIRST, FOR A REASON BEYOND TIDINESS. Werkzeug is one
// GIL-bound process and every boot request lands on it together; whoever asks first is served
// first. `/health` is the cheapest of them and the most visible, so it leads and nothing waits.
//
// 🔴 WHAT MAKES THIS SAFE IS `window.__bootDone` (7.5.8, the commit before this one), NOT CARE.
// Ten browser specs gated on `__uiReady` — "the modules ran" — and then measured GEOMETRY, which
// worked only because this chain awaited everything. Reordered without a settle signal the page is
// simply SHORTER while the rest lands, and they fail on absurd preconditions rather than on
// anything that names the cause. That is why this was built once, reverted, and rebuilt.
(async () => {
  // ── phase 1: the header, unawaited, and first ────────────────────────────────────────────
  pollReady();
  startIdleVram();
  pollComfy();
  pollAcestep();
  // ── phase 2: every other boot fetch, ISSUED HERE, AWAITED BELOW OR NOT AT ALL ────────────
  const pAppSettings = loadAppSettings();
  const pVoices = loadVoices();
  const pGpus = loadGpus();
  const pDevices = loadDevices();
  const pEnhance = loadEnhanceInfo();
  const pRate = loadRenderRate();
  const pBooks = loadBooks();
  // 8.0-m3: the song-template picker. Issued here with the rest and deliberately NOT awaited —
  // it fills a control on a tab that is not on screen, so making the first paint wait for it
  // would put a fetch for the ACE-Step tab in front of the tab the user is actually looking at,
  // which is the exact ordering 7.5.8 was written to undo.
  const pAceTpl = loadAceTemplates();
  // 8.1-m1: the "Sing it like" picker's options. Same reasoning as pAceTpl — not awaited, fills a
  // control on a tab that is not on screen. Order against pAceTpl does not matter: the select
  // keeps a token it has no option for rather than discarding it (see ensureRefOption).
  loadAceRefs();
  loadAceSources();
  // ⚠️ NOT awaited and NOT in __bootDone: `startAceTray` only arms a 2 s timer whose first tick
  // returns immediately while the ACE-Step section is hidden, so there is no boot data here to
  // wait for — unlike `pAceTpl` above, which fetches.
  startAceTray();
  // Reopen the tab the user was on (default: Playground). A live render found by
  // resumeRender() still wins.
  //
  // 'library' and 'output' were TOP-LEVEL tabs until 4.1-M13 and are now sub-tabs of Book,
  // so a browser that saved one of them would restore a tab that no longer exists and show
  // an empty page. Migrate instead: land on Book, on the sub-tab they meant. Output cannot
  // restore without an opened book, so it falls back to Library — which switchBkTab enforces
  // anyway.
  let t = '';
  try {
    t = UIS.getItem('vocalis-tab') || '';
  } catch (e) {}
  if (t === 'library' || t === 'output') {
    switchBkTab('library', false);
    t = 'book';
  }
  // Migrate the former top-level tab key to its current SillyTavern sub-tab.
  //
  // `stTab` is private to its module; use its setter. The parent tab must open before the sub-tab
  // changes so the selected pane is visible when it is painted.
  // 📌 `stTabSet`, NOT `switchStTab`: this runs before `switchTab('sillytavern')` opens the
  // section, and switching a sub-tab inside a hidden section paints a pane nobody is looking at.
  if (t === 'clips') {
    stTabSet('clips');
    t = 'sillytavern';
  }
  // Migrate the former top-level KoboldCpp tab key to its current LLM sub-tab.
  // 📌 `llmTabSet`, NOT `switchLlmTab`, for the reason spelled out above: this runs
  // before `switchTab('llm')` opens the section, and switching a sub-tab inside a hidden
  // section paints and polls a pane nobody is looking at.
  if (t === 'kobold') {
    llmTabSet('kobold');
    t = 'llm';
  }
  // 📌 A tab clicked WHILE THE MODULES WERE LOADING wins over the remembered one. The click is the
  // more recent statement of intent, and honoring it is the difference between "the page was slow"
  // and "the page ignored me" — which is what the old ReferenceError looked like from the outside.
  const want = window.__pendingTab || t || 'playground';
  // 🔴 THE ONLY TWO THE FIRST PAINT WAITS FOR, AND ONLY BECAUSE THEY BELONG TO NO ONE TAB.
  //
  // `loadAppSettings` reconciles the type scale that index.html's pre-paint block GUESSED from
  // localStorage — defer it and the page RESIZES under the user a beat after it appears, which is
  // the one deferral he would actually notice. `loadVoices` fills the voice pickers, and every tab
  // has one. Everything else belongs to a tab, and `switchTab` loads the tab you land on: that is
  // what js/ui/tabs.js's registry is FOR.
  //
  // 🔴 `allSettled`, NEVER `all`, AND THIS IS NOT A STYLE PREFERENCE. `all` rejects on the FIRST
  // failure; the rejection escapes this IIFE, so `switchTab` below never runs and the window stays
  // BLANK. One 500 from /voices and the entire page is gone. With `allSettled` the voice pickers
  // are empty and everything else works, which is the difference between a degraded page and no
  // page. (This is the hardening the reverted attempt was missing.)
  await Promise.allSettled([pAppSettings, pVoices]);
  // ⚠️ BOOK IS THE ONE TAB THAT NEEDS MORE THAN ITS REGISTERED LOADER. `restoreBook` reopens the
  // book you had open and quotes an enhance ETA while doing it, so it needs the shelf, the enhance
  // info and the render rate. Landing ON Book, waiting is the honest thing — a Book tab with no
  // book selected is not "loaded". Anywhere else it finishes in the background below, because
  // nothing on screen is showing it. ⚠️ try/catch for the same reason as `allSettled` above.
  if (want === 'book') {
    await Promise.allSettled([pBooks, pEnhance, pRate]);
    try {
      await restoreBook();
    } catch (e) {
      console.error('restoreBook failed', e);
    }
  }
  switchTab(want);

  // ── phase 3: the rest, off the critical path. The page is usable from this line down. ────
  // The requests started above; only their per-feature waits are deferred. Awaiting them here would
  // block the first paint, while each task's internal awaits still respect its dependencies.
  const pRestore =
    want === 'book'
      ? null
      : (async () => {
          await Promise.allSettled([pBooks, pEnhance, pRate]);
          await restoreBook();
        })().catch(e => console.error('restoreBook failed', e));
  const pSettings = Promise.allSettled([pGpus, pDevices, pRate]); // ⚙ Settings rows and the ETA quote
  // the clip list also powers the Book tab's cached-audition player
  const pLib =
    want === 'playground'
      ? null
      : (async () => {
          await pgLibLoad();
        })().catch(e => console.error('pgLibLoad failed', e));
  // 🔴 `resumeRender` RUNS AFTER `restoreBook`, AND THAT IS A REAL DEPENDENCY, NOT TIDINESS.
  // It reattaches to a live render and writes the live job's book into #bookSelect and its voice
  // into #voice — but only `if([...$('bookSelect').options].some(…))`, so against an unpopulated
  // shelf it does nothing AT ALL and says nothing about it. It also overwrites #bookDetails with
  // "render in progress", which restoreBook would put back if it ran second. "A live render still
  // wins" is the rule, and it only holds while this is last. Awaiting pRestore gets both: the
  // shelf is loaded, and restoreBook has already had its turn.
  const pRender = (async () => {
    await pRestore;
    await resumeRender();
  })().catch(e => console.error('resumeRender failed', e));
  // 🔴 `__bootDone` MEANS "THE BOOT DATA ARRIVED", WHICH IS NOT WHAT `__uiReady` MEANS (7.5.8).
  //
  // `__uiReady` is set at the top of this module, before a single fetch is issued: it means THE
  // MODULES RAN, and it is the exact flag the #tabs click listener consults. This flag is the
  // other one — the page has its full HEIGHT — and ten browser specs need to tell them apart now
  // that there is real time between them.
  //
  // 📌 DEFINED BY WHAT HAS SETTLED, NEVER BY WHERE IT SITS IN THE SOURCE. Add a boot fetch, or
  // move one off the critical path, and it must appear in THIS list. Get that wrong and every spec
  // gating on it measures a page that is still filling in — measured, that is 17 geometry checks
  // in `wbedit_browser_spec.mjs` and 2 runs in 3 of `clips_chapters_browser_spec.mjs`, all of them
  // shaped "the section runs off the bottom of the window (0px vs 570px)". Nothing broken in the
  // product; just a shorter page, which is what progressive loading looks like from a tape measure.
  //
  // Stems reconnects only after the boot data has settled; it does not delay page readiness.
  // 8.0-m3: `pAceTpl` is in here because the note above says every boot fetch is, not because the
  // song picker is on screen — it is not, the ACE-Step section ships hidden. But `__bootDone`
  // means "the boot data arrived", and a fetch left out of this list is exactly the omission that
  // makes the flag mean something subtly different from what its readers assume. It is one small
  // request and it settles long before the slow ones beside it.
  Promise.allSettled([pRestore, pSettings, pLib, pRender, pAceTpl]).then(async () => {
    window.__bootDone = true;
    // Reattach to a live split without starting a new job.
    await ssResume();
  });
})();
