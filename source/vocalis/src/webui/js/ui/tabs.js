// ui/tabs.js — the top-level tab bar and the Book sub-tab bar, and nothing else (7.3-m2a).
//
// 44 lines out of ONE banner, `── tabs ──`. Three definitions, two of them exported.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 §4 SAID FIVE `switch*Tab` FUNCTIONS AND ONLY TWO OF THEM ARE HERE, WHICH IS §11.10 AGAIN:
// a banner names what its author was writing that day, so check it against the defs.
//
//   switchTab      ✅ here — the top-level bar
//   switchBkTab    ✅ here — Book ▸ Generate | Library, declared under the same banner
//   switchVTab     ✅ ALREADY GONE, into js/voices/voices.js at m8b, because the Voices sub-tab
//                  state (`vcTab`, `vcTabWant`) is written by the /health fallback and read by
//                  `renderVoiceList` — it is that tab's state, not tab machinery
//   switchVsTab    ❌ NOT here. It sits under `── Voice Studio ──` with its own
//                  `UIS.getItem('vocalis-vstab')` restore two lines below it, and that restore
//                  runs at PARSE TIME (it is in `_PARSE_TIME_SURFACE`). Moving the function
//                  without the restore makes the restore call `undefined` during load; moving
//                  both means taking a statement out of the middle of another feature's area.
//                  🔴 IT TRAVELS WITH `media/voiceswap.js` AT m10, not with this file.
//   switchStTab    ❌ NOT here either, and for the same shape: it lives under
//                  `── SillyTavern sub-tabs ──` beside `stTab` and `ST_TABS`, whose restore is
//                  also parse-time. That trio moves together, and `_PARSE_TIME_SURFACE`'s entries
//                  for `stTab` and `ST_TABS` have BOTH named the wrong destination once each.
//
// 📌 SO THE RULE THAT ACTUALLY DECIDES IT IS NOT "IS IT A TAB FUNCTION". It is: **where does the
// statement that restores this tab live?** `switchBkTab`'s restore is under this banner, ten lines
// below it, so it travels — which is why this cut is 44 lines and mechanical rather than three
// statements lifted out of three other features. Same question as m8b's shape-3 escape.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — TWO NAMES, and neither is for the same reason.
//
//   switchTab      SIX inline call sites (the Voice Studio deep-links, `$('vtToPg')`) plus FOUR
//                  browser specs — devices, st_characters_live, voices_player and wbedit all
//                  evaluate `switchTab('…')` in the page's global scope, and a spec caller is a
//                  caller (§11.16). It also has to stay on the shim for that reason alone.
//   switchBkTab    ONE caller and it is js/main.js: the boot sequence migrates a saved
//                  `library`/`output` tab to `book` and calls `switchBkTab('library', false)` to
//                  enforce the fallback. It read that off the page's scope chain until now and
//                  imports it properly as of this commit.
//
// ⚠️ `bkTab` STAYS PRIVATE and it is a `let` this file reassigns, so it could not be published
// even if something wanted it (§11.4's third row — `Object.assign` copies a value once). Its only
// reader outside `switchBkTab` is `switchTab`'s `if(name==='book'&&bkTab==='library')`, in this
// file. The straddling-`let` scan confirmed zero writers on the other side of the edge.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 FIFTEEN IMPORTS, WHICH IS THE MOST OF ANY MODULE IN 7.3, AND THAT IS THE POINT OF THIS FILE.
//
// `switchTab` is where the whole application's lazy loading is expressed: entering a tab loads its
// data, and LEAVING one stops its poller. Nine of the fifteen are enter/leave pairs — `kobLoadAll`/
// `kobPollStop`, `loadNomi`/`nomiPollStop`, `stLogStop`+`stPollStop`, `devPollStart`/`devPollStop` —
// and every one of those pairs has a module header warning that dropping the STOP half leaves an
// interval polling forever against a tab nobody is looking at. **This file is the only place that
// invariant is visible in one screen.**
//
// ✅ ONE NAME IS STILL READ OFF THE PAGE as a bare identifier, which a module may do (the classic
// script's top-level declarations are in the global declarative record and it always runs first):
// `UIS`, and it is the one that is NEVER movable (§11.2 — the server substitutes `{{UI_STATE}}`
// into the page and a module gets no substitution). The other five closed exactly as this note
// predicted they would: `stTab`/`switchStTab` at m2b (as `stTabNow()`, because the `let` cannot be
// published), `vsLoadAll` at m9a, `loadPgLib` at m6e, and `nomiPairLoad` at m12a.
// 📌 The note is kept rather than deleted because the shape of it is the point: a reach that names
// scheduled work is fine, and every one of these was retired by the milestone it named.
import { $ } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { onTabSwitch } from './tabswitch.js'; // 7.5.6 — the mechanism; this file is the knowledge
import { loadLibrary } from '../book/library.js';
import { loadBulk } from '../media/bulk.js';
import { voiceListLoad } from '../voices/vcstate.js'; // 7.5.6 — one way to ask, see pgstate
import { stPollStop } from '../st/chars.js';
import { stLogStop } from '../st/log.js';
import { loadNomi, nomiPollStop } from '../st/nomi.js';
import { pairLoad } from '../st/pairing.js';
import { nomiPairLoad } from '../st/nomipair.js'; // 7.3-m12a: was a page global read off the scope chain
import { alignDevCols, devPollStart, devPollStop, loadDevices } from '../sys/devices.js';
// 9.5-m1: the LLM tab owns TWO engines now, so this file dispatches to the sub-tab
// router rather than to one engine's loader. `llmLoadAll` opens whichever sub-tab was
// last showing; `llmPollStop` stops BOTH pollers, which is the half that must not be
// dropped -- see js/llm/tabs.js.
import { llmLoadAll, llmPollStop } from '../llm/tabs.js';
// 🔴 `switchStTab` AND `stTabNow` ARRIVED AS IMPORTS AT 7.3-m2b, and the second one is the reason
// this line is worth a comment. `switchTab` used to read the bare `stTab` off the classic script's
// scope chain; `stTab` is a `let` that `switchStTab` reassigns, so js/st/tabs.js deliberately does
// NOT export it — a shim copy would be frozen at load and a browser spec polls it. `stTabNow()` is
// the accessor, and the ONE call below is the only non-verbatim character in this file's move.
import { switchStTab } from '../st/tabstate.js'; // 7.5.6 — the dispatcher lives with the state
import { ssLoadAll } from '../media/stems.js';
import { spLoadAll } from '../media/speech.js';
import { switchStudioPanel } from '../media/studio-tabs.js';
import { stTabNow } from '../st/tabstate.js';
import { pgLibLoad } from '../pg/pgstate.js'; // 7.5.6 — was `loadPgLib` from playground.js
import { loadAceRefs, loadAceSources } from '../ace/form.js'; // 8.1 — the pickers
// ── tabs ────────────────────────────────────────────────────────────────
// 🔴 `switchTab` MOVED TO ui/tabswitch.js AT 7.5.6 AND THE DISPATCH BELOW STAYED HERE. That file
// has the argument in full; the short version is that five of the modules this one imports a loader
// from imported `switchTab` straight back, and those mutual edges made `src/webui/js` a single
// strongly-connected component of 18 modules — which has no defined evaluation order, which the
// bundler then linearized differently from the browser, which broke DOM wiring that runs at
// module-eval. The knowledge stayed where the knowledge belongs: this file knows what a tab
// CONTAINS, `tabswitch.js` knows only how to paint one.
//
// ⚠️ IMPORTED, NOT RE-EXPORTED, and the difference matters to two different readers. This file
// really calls `switchTab` — the `#tabs` click listener at the bottom of this file — so the import
// is a genuine use rather than plumbing. What it does NOT do is hand the name back out:
// `_websrc.mjs`'s spec surface lists `ui/tabswitch.js` in its own right now, so the twenty browser
// harnesses get `switchTab` from the module that actually owns it.
// 📌 `export { x } from …` and import-then-export were both tried here and both tripped
// `test_webui_modules.py`'s import scanner, which understands neither — no other module in this
// tree uses either form. Needing new syntax out of a guard is a good reason to look for a shape
// that needs none, and "list the module that owns the name" was the truer fix anyway.
import { switchTab } from './tabswitch.js';

// 📌 REGISTERED AT MODULE-EVAL, VERBATIM FROM THE OLD `switchTab` BODY. Order inside the callback
// is preserved exactly: the leaving-stops still run after the entering-loads, which is what keeps
// `if(name!=='kobold')kobPollStop()` from stopping a poll `kobLoadAll()` just started.
onTabSwitch(name => {
  if (name === 'book' && bkTab === 'library') loadLibrary(); // the sub-tab owns its own refresh
  if (name === 'playground') pgLibLoad();
  if (name === 'voices') voiceListLoad();
  if (name === 'voicestudio') {
    let panel = 'stems';
    try {
      panel = UIS.getItem('vocalis-vstab') || 'stems';
    } catch (e) {}
    switchStudioPanel(panel);
    if (panel === 'speech') spLoadAll();
    else ssLoadAll();
  }
  if (name === 'bulk') loadBulk();
  // 8.1-m1: refresh the "Sing it like" options on entry. The list is the Stems library, and the
  // ordinary way a new reference appears is that the user just split a song on another tab — so a
  // list fetched once at boot goes stale in exactly the case someone is about to use it, and the
  // only cure would be a page reload. One cheap read per visit, like `pairLoad` below.
  // 8.1-m3: sources go stale faster than references — the ordinary way a new one
  // appears is that a render just finished in the tray on this very tab.
  if (name === 'acestep') {
    loadAceRefs();
    loadAceSources();
  }
  if (name === 'llm') llmLoadAll();
  if (name !== 'llm') llmPollStop(); // leaving LLM -> stop BOTH engines' status polls
  if (name === 'nomi') loadNomi();
  if (name !== 'nomi') nomiPollStop(); // leaving Nomi -> stop the live card poll
  if (name !== 'sillytavern') {
    stLogStop();
    stPollStop();
  } // leaving ST -> stop the live log tail and the character poll
  if (name === 'sillytavern') switchStTab(stTabNow()); // open the remembered sub-tab (Logs or Characters)
  // 7.2-m4: `nomiPairLoad` sits beside `pairLoad` because the two panels sit beside each other.
  // Fetched on ENTRY rather than at boot because a token is a credential and a locked vault
  // answers 423 — asking once per visit keeps "locked" and "unpaired" distinguishable.
  if (name === 'settings') {
    alignDevCols();
    loadDevices();
    devPollStart();
    pairLoad();
    nomiPairLoad();
  } // first chance to measure — the panel was hidden
  else devPollStop(); // the probe costs a round trip per satellite
});
// 🔴 DOCKER EDITION: EACH VOICE STUDIO SUB-TAB LOADS ITS OWN DATA ON ENTRY, AGAIN. The legacy
// `switchVsTab` did (`stems` -> ssLoadAll, `speech` -> spLoadAll); the Docker rewrite of the sub-tab
// bar (`media/studio-tabs.js`, which only paints the panels) dropped that, so the Speech list
// stayed empty when you clicked into it from Stems until you pressed ↻, and `onTabSwitch` above
// only loads whichever panel was remembered when the tab opened. Found porting
// `test_voices_folders_browser.py`, which clicks into Speech the way a user does.
// 📌 Registered here and not in studio-tabs.js because this file already imports both loaders; the
// other direction would add edges to the module graph that `test_webui_modules.py` polices.
// This listener runs after studio-tabs' own (it is evaluated first, as an import of this file).
/** @type {VEl} */ ($('vsTabs')).addEventListener('click', e => {
  const btn = /** @type {HTMLElement} */ (e.target).closest('[data-vstab]');
  const name = btn instanceof HTMLElement ? btn.dataset.vstab : undefined;
  if (name === 'speech') spLoadAll();
  else if (name === 'stems') ssLoadAll();
});

// 🔴 THE `#tabs` CLICK LISTENER STAYS IN index.html AND DID NOT COME WITH THIS CUT. It is the one
// statement out of the 44 that was deliberately left behind, and the reason is the opposite of
// everything else in §3.1: its EXISTENCE at parse time is the feature. The tab bar's markup is
// parsed thousands of lines before the module graph is fetched, so the user can click it during
// load — and the inline listener parks that click in `window.__pendingTab` for js/main.js to honor
// (§11.6 item 3). Registered here instead, the listener does not exist until this module executes,
// and a click before that is silently LOST — no queue, no error, nothing to trace.
//
// 📌 `_PARSE_TIME_SURFACE` CANNOT SEE THIS, AND THAT IS WORTH KNOWING. It measures what the page
// NEEDS at parse time (a name read before its module has run). This is the mirror image: something
// the page PROVIDES at parse time that must keep being provided. Nothing scans for it —
// `tests/test_webui_modules.py::test_the_tab_bar_cannot_call_a_loader_before_the_modules_land` is a
// hand-written guard on this exact line, and it is what caught the move. Its message says "find it
// before deleting this", which is the right instruction and was the right answer.
//
// ⚠️ The `#bkTabs` listener DID come, and the difference is reachability: every
// `section[data-panel]` except Playground ships `style="display:none"`, so the Book sub-tab bar
// cannot be clicked until `switchTab('book')` has run — which is after the shim by construction.
// Book ▸ Generate | Library. Chapters is not a tab: it is the DETAIL half of Library, and it
// lives under the book list. Library and Output used to be top-level tabs, which said they
// were peers of the whole Playground; they are two views of one book.
let bkTab = 'generate';
/**
 * @param {string} name
 * @param {boolean} [load] - `false` suppresses the `loadLibrary()` call on the `library` branch;
 *   omitted (`undefined`) behaves like `true` — see the `!==false` test below.
 */
export function switchBkTab(name, load) {
  bkTab = name;
  try {
    UIS.setItem('vocalis-bktab', name);
  } catch (e) {}
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#bkTabs button')).forEach(b =>
    b.classList.toggle('active', b.dataset.bktab === name),
  );
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-bkpanel]')).forEach(
    s => (s.style.display = s.dataset.bkpanel === name ? '' : 'none'),
  );
  if (load !== false && name === 'library') loadLibrary();
}
/** @type {VEl} */ ($('bkTabs')).addEventListener('click', e => {
  if (/** @type {HTMLElement} */ (e.target).dataset.bktab)
    switchBkTab(/** @type {string} */ (/** @type {HTMLElement} */ (e.target).dataset.bktab));
});
// 'output' was a sub-tab for one commit (4.1-M13/M14) before it became a section. A browser
// that saved it would land on a tab that no longer exists and show an empty Book panel.
try {
  let t = UIS.getItem('vocalis-bktab');
  if (t === 'output') t = 'library';
  if (t) switchBkTab(t, false);
} catch (e) {}

// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ THE `#tabs` LISTENER ARRIVED AT 7.3-m13, AND IT IS THE LAST STATEMENT TO LEAVE index.html.
//
// §11.20 records why it was the ONE statement deliberately left inline through twelve milestones,
// and the reason was the opposite of everything else in §3.1: **its existence at parse time was the
// feature.** The tab bar's markup is parsed thousands of lines before the module graph is fetched,
// so a user could click it during load — and `switchTab` calls eight module-only loaders, so an
// early click opened an EMPTY tab and left the previous tab's pollers running (§11.6 item 3).
//
// 🔴 SO THE `__uiReady` / `__pendingTab` MACHINERY IS NOT VESTIGIAL AND IS NOT DELETED. It looks
// redundant now — this listener attaches at module-eval, by which point `switchTab`'s imports have
// all resolved — and it is still doing work: **`js/main.js` sets `window.__uiReady` in its module
// body, and main.js is the LAST module to evaluate.** Between this line running and that one there
// is still a window, smaller than before but not zero, and a click landing in it is still recorded
// rather than dropped. Deleting the guard would trade a real (if brief) correctness property for
// two lines, and the failure mode is a tab that opens empty on a slow first load — which is the
// exact bug §11.6 spent a browser run finding.
//
// ⚠️ THE WINDOW IS NOW BOUNDED BY THE MODULE GRAPH RATHER THAN BY THE PAGE, which is a change in
// kind: before m13 a click during the ~8,000-line parse hit an inline `switchTab` that existed but
// whose loaders did not. Now nothing responds to a click until this file evaluates, and by then
// `switchTab` is whole. The queue is for main.js's ordering only.
/** @type {VEl} */ ($('tabs')).addEventListener('click', e => {
  const t = /** @type {HTMLElement} */ (e.target).dataset.tab;
  if (t) window.__uiReady ? switchTab(t) : (window.__pendingTab = t);
});
