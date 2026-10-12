// st/tabs.js — the SillyTavern sub-tab strip: which of the seven panes is showing, the switch that
// opens one, and the Ctrl+F binding that belongs to whichever editor pane is open (7.3-m2b).
//
// 72 lines out of one banner, `── SillyTavern sub-tabs: Logs | Characters ──`. Three definitions,
// **zero references from index.html** — the cleanest leak count of any cut in 7.3.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WHY `st/` AND NOT `ui/tabs.js`, WHICH IS WHERE §4 FILED `switchStTab`.
//
// m2a established the rule that decides it: a tab function travels with the banner its parse-time
// RESTORE lives under, and this one's — `try{const t=UIS.getItem('vocalis-sttab');
// if(ST_TABS.includes(t))stTab=t;}` — is here, nine lines above the function, not under `── tabs ──`.
// So the choice was never "tabs.js or here"; it was "this group, or this group split across two
// files". 📌 And once it is one group, `st/` is the honest home: `switchStTab` dispatches to
// `stLogStart`, `loadStChars`, `wbLoadLib` ×3 and `loadScenes` — it is the SillyTavern tab's own
// router, sitting beside the four modules it drives, not a shared `ui/` helper.
//
// ⚠️ `_PARSE_TIME_SURFACE`'s entries for `stTab` and `ST_TABS` had named THREE different
// destinations between them before this landed (`st/chars.js` m11, then `ui/tabs.js` m2, then
// nothing). The last of those was deliberate — a pin entry that names WHY a group must move together
// ages well and one that names WHERE it goes does not.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — ONE NAME, `switchStTab`.
//
// `js/ui/tabs.js`'s `if(name==='sillytavern')`, `js/scenes/scenes.js`'s ✎ Edit round trip, and two
// browser specs. The `#stTabs` click listener below is its other caller and traveled with it.
//
// ⚠️ `ST_TABS`, `stTabNow()` AND `stTabSet()` MOVED ON AGAIN, INTO js/st/tabstate.js. The first draft
// of this file kept all four together, which is what the banner suggested, and it produced FOUR
// import cycles at once: st/chars.js, wb/open.js, ui/tabs.js and js/main.js each read or write the
// current sub-tab, and this file imports from st/chars.js, st/log.js, scenes/scenes.js and wb/open.js
// in order to dispatch to them. 🔴 The browser said so plainly — `ReferenceError: stTab is not defined
// at js/wb/open.js:230` — and the fix was not to add four imports but to split the STATE out, exactly
// as m8a did for `vc`. tabstate.js imports nothing, so nothing can cycle through it.
//
// 📌 THE SCOPING LESSON, AND IT COST A BROWSER RUN: the leak scan reads index.html. **A name declared
// in the page can also be read by a MODULE**, and there are fifty of them now — so "zero leaks out of
// the page" is only half the question. `temp/scope.py` scans `src/webui/js/**` for bare reads too as
// of this commit. THREE of the four readers here were invisible to the page-only scan.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ TWO LISTENERS TRAVELED AND NEITHER IS THE `#tabs` CASE (§11.20).
//
// `$('stTabs')` is inside `<section data-panel="sillytavern" style="display:none">`, so the strip
// cannot be clicked until `switchTab('sillytavern')` has run — which is after the shim, by
// construction. The `document`-level Ctrl+F binding IS globally reachable from parse time, and it is
// still safe: its first statement returns unless an editor pane is open on the current sub-tab, which
// cannot be true before the shim either, and until then Ctrl+F does what the browser does — which is
// the behavior its own comment says it is protecting.
//
// 📌 `if(typeof stTab === 'undefined' || …)` in that handler is dead weight rather than a guard now:
// the local above it is always a string. Kept because this cut moves code and changes nothing that is
// not forced (§6 step 4); deleting it is a separate decision about a hazard that used to be real.
import { $ } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
// 🔴 THE `let` ITSELF LIVES IN js/st/tabstate.js AND IS NOT IMPORTED HERE. Four modules read it
// and one writes it before this router exists; declaring it in THIS file would cycle through
// every one of them, because this file imports from st/chars.js, st/log.js, scenes/scenes.js and
// wb/open.js in order to dispatch to them. tabstate.js imports nothing, so it cannot cycle.
import { onStTabSwitch, stTabNow, stTabSet } from './tabstate.js';
import { loadScenes } from '../scenes/scenes.js';
import { loadStChars, stPollStop } from './chars.js';
import { stLogStart, stLogStop } from './log.js';
import { WB_KIND } from '../wb/kind.js';
import { WB_PANE, wbGo, wbLoadLib } from '../wb/open.js';
import { wbLoadPrompt, wbPromptDirty } from '../wb/prompt.js';
import { wbFindOpen } from '../wb/edit.js';
import { stExtensionSettingsLoad } from './extension-settings.js';
// ── SillyTavern sub-tabs: Logs | Characters ──────────────────────────────
// Logs is a live tail of the server log (watch narration requests land as they
// come in); Characters is the per-character voice map above. Modeled on
// switchVsTab. switchTab() opens the remembered sub-tab when the ST tab is
// entered, and stops the tail when it's left.
// 7.5.6 — `stTabApply`, not `switchStTab`: the exported name is st/tabstate.js's dispatcher and
// this is the behavior behind it. Registered at the bottom of this file. See that file's note.
/** @param {string} name */
function stTabApply(name) {
  stTabSet(name); // ← 7.3-m2b: the `let` lives in st/tabstate.js
  try {
    UIS.setItem('vocalis-sttab', name);
  } catch (e) {}
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#stTabs button')).forEach(b =>
    b.classList.toggle('active', b.dataset.sttab === name),
  );
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-stpanel]')).forEach(
    s => (s.style.display = s.dataset.stpanel === name ? '' : 'none'),
  );
  // 🔴 Three-way now, not `logs ? … : characters`. §10.1 added a third panel, and the old
  // else-branch would have started the CHARACTER poll every time Clips opened — a poll that
  // cannot be seen, never stops, and targets a hidden tab.
  // 🔴 A SWITCH, NOT AN ELSE-BRANCH. This was `logs / characters / else -> loadScenes()`, and
  // its own comment already recorded that the two-way version started the character poll
  // whenever Clips opened. 7.0 adds two more panes, and the else-branch would have run
  // loadScenes() for both of them — a scene list fetched, and no document library.
  stLogStop();
  stPollStop();
  // §6.4.1 — ONE prompt card for the whole tab, shown on the two editor panes and nowhere else.
  // It is a single stored value, so it is a single control (§6.0's own argument for keeping the
  // pairing token out of both panes); it is meaningless on Logs and Clips.
  const wantsPrompt = name === 'cards' || name === 'books' || name === 'personas';
  /** @type {VEl} */ ($('wbPromptCard')).style.display = wantsPrompt ? '' : 'none';
  // 🔴 5.5 — DO NOT RELOAD OVER UNSAVED TYPING. `wbLoadPrompt` assigns `.value` on all three
  // boxes unconditionally, and the card is SHARED by the three editor panes, so switching
  // Cards → Books threw away a half-written system prompt with no dirty check and no confirm.
  // The pane's own help text directs users here when a pass misbehaves, often while a prompt is
  // being edited.
  //
  // A reload is only needed when the card is coming back into view; between the three editor
  // panes it is the SAME card showing the SAME stored value, so skipping the reload while dirty
  // costs nothing at all.
  if (wantsPrompt && !wbPromptDirty()) wbGo('cards', wbLoadPrompt());
  switch (name) {
    case 'logs':
      stLogStart();
      break;
    case 'characters':
      loadStChars();
      break;
    case 'cards':
      wbGo('cards', wbLoadLib('cards'));
      break;
    case 'books':
      wbGo('books', wbLoadLib('books'));
      break;
    case 'personas':
      wbGo('personas', wbLoadLib('personas'));
      break;
    case 'clips':
      loadScenes();
      break;
    case 'extension-settings':
      stExtensionSettingsLoad();
      break;
  }
}
onStTabSwitch(stTabApply);
/** @type {VEl} */ ($('stTabs')).addEventListener('click', e => {
  if (/** @type {HTMLElement} */ (e.target).dataset.sttab) stTabApply(/** @type {HTMLElement} */ (e.target).dataset.sttab);
});
// §6.6 — Ctrl+F belongs to the editor only while one is open on the sub-tab being looked at.
// 🔴 Anywhere else the browser's own find stays untouched: this app is mostly long lists, and
// taking that key globally would be a regression in every tab that has no find bar.
document.addEventListener('keydown', e => {
  const f = (e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey) && !e.altKey;
  if (!f) return;
  const stTab = stTabNow(); // ← 7.3-m2b, was a page global
  if (typeof stTab === 'undefined' || !(stTab in WB_KIND)) return;
  // `WB_PANE` is `wb/open.js`'s own cache, declared `{}` there — not this file's to type. The
  // cast says only what this read site already knows: it's keyed by sub-tab name, valued by the
  // editor pane `wbEl` found (or undefined, on a cold cache — hence the `$` fallback).
  const pane = /** @type {Record<string, VEl|undefined>} */ (WB_PANE)[stTab] || $('wbEditor_' + stTab);
  if (!pane || pane.style.display === 'none') return;
  // 🔴 AND THE SILLYTAVERN PANEL ITSELF HAS TO BE IN FRONT (9.6.8). Every check above this line
  // asks about the SUB-tab, and `stTab` is persisted in UIS (`vocalis-sttab`) — so it goes on
  // saying 'cards' from whichever tab you are looking at, including a fresh load. `switchTab`
  // hides the `<section data-panel>`, never the editor pane nested inside it, so `pane.style
  // .display` stays whatever it was: on EVERY other tab this handler was calling preventDefault
  // and opening a find bar on a panel nobody could see. Taking that key outside the one pane that
  // has a find bar is a regression in every
  // tab that is a long list, which is most of them.
  // 📌 `closest`, not a hard-coded `[data-panel="sillytavern"]`: the pane's own ancestor cannot
  // disagree with where the pane actually is, and a selector naming the panel by name could.
  const panel = /** @type {HTMLElement|null} */ (pane.closest('section[data-panel]'));
  if (!panel || panel.style.display === 'none') return;
  e.preventDefault();
  wbFindOpen(stTab);
});
