// scenes/scenes.js — the SillyTavern ▸ Scene Clips tab: the list of scenes, playground clips and
// uploads; the one moving <audio> player; the Join tray; per-row Enhance; and the staged-edit
// clipboard (7.3-m7, §5's m7 in one commit).
//
// 988 lines out of SEVEN adjacent banners, one contiguous cut — `── Clips tab (6.0 §7) ──`,
// `── m4i / §9a.3: whose voice is this? ──`, `── §10.3 / §10.4 — chapters inline ──`,
// `── §10.5 — the player sits in a row of its own ──`, `── 6.3 — Enhance, on the row ──`,
// `── §7's Join tray ──` and `── 6.1-m1b — staging edits ──`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 §5 SAID FOUR BANNERS AND 353 LINES, AND THAT BOUNDARY PRODUCES A NAMESPACE, NOT A MODULE.
// Measured at `ed443dd`, both boundaries, with the same scan:
//
//   the four banners §5 names   353 lines  21 defs  🔴 17 leaked names
//   this file's boundary        988 lines  44 defs  ✅  2 leaked names
//
// At the small boundary `scLib` ALONE is referenced 72 times from outside it, reaching down
// through the three banners §5 does not mention. `scLib` is the tab: the item list, the tick
// order that IS the join order, which scene's chapters are open, which clip owns the player, the
// live enhance jobs, the clipboard and the staged edit plan. Every one of the seven banners reads
// or writes it, so any cut that leaves some of them behind has to publish it — and a `const`
// object that six features mutate is the definition of a module that has not been found yet.
//
// 📌 SO §4's `scenes/player.js`, `scenes/join.js` AND `scenes/edit.js` ARE CANCELED, for the
// same reason `book/render.js` (m6a) and `book/output.js` (m4l) were: two files whose only
// neighbor is each other are one file. The three of them would import `scLib` from here and
// mutate it, which is the shape §11.2 rejected for `util/uistate.js` — a shared mutable global
// wearing an import statement. §11.12 says §4's table is a plan, not an inventory; this is the
// fourth entry it has been wrong about, and for the fourth time the measurement is what settled it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — THREE NAMES out of 44 definitions, and only two are for the page.
//
//   loadScenes    `switchStTab`'s `case 'clips'` — entering the sub-tab is what loads the list.
//                 ⚠️ It is also the ONLY name in this file the page can still see, apart from the
//                 one below, so a new caller in index.html means a new export, not a new global.
//   scCopyClip    🔴 THE PLAYGROUND, which sits ABOVE this range and stays inline until m6/`pg/*`.
//                 Its 📋 Copy clip button is where the round trip usually starts — §3.1's
//                 argument that the clipboard, not the ↩ button, is the primary mechanism — so
//                 the caller is in another feature by design, not by accident.
//   scLib         🔴 A SPEC, AND NOTHING ELSE. tests/clips_favorites_browser_spec.mjs reads
//                 `scLib.items` as a BARE VALUE to prove that a slow older `loadScenes()` cannot
//                 overwrite a newer one's answer. A spec that evaluates a bare name in the page
//                 is a caller the page-only leak scan cannot see (§11.16), and m11b shipped one
//                 straight into a `ReferenceError` for exactly this reason.
//
// ✅ AND PUBLISHING THIS ONE IS SAFE, WHICH IS NOT TRUE OF STATE IN GENERAL. `Object.assign`
// copies a value ONCE (§11.4): a `let` the module reassigns would be frozen at its load-time
// value on the shim, which is quieter than a crash and strictly worse. `scLib` is a `const` that
// is only ever MUTATED — `scLib.items=`, `scLib.sel=`, `delete scLib.chap[r]` — so the shim's
// copy is the same object the module holds and every mutation is visible through it. That is the
// middle row of §11.4's table, not an exception to it. 🔴 If a future change ever reassigns
// `scLib` itself, this export becomes a lie and the spec starts passing against a stale list.
//
// ⚠️ FORTY-ONE NAMES STAY PRIVATE, including `renderScenes`, the whole player (`scPlace`,
// `scEnsurePlayer`, `scStop`, `scSeekPlay`), the Join tray, the chapter rows and the staging.
// The measured leak count out of the 988-line range was exactly the two above.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ FOUR NAMES LEAVE `_PARSE_TIME_SURFACE` IN THIS COMMIT, ALL FOUR WITHOUT AN ARROW.
//
// `loadScenes`, `renderScenes`, `renderJoinTray` and `scSeekKey` were each handed to something as
// a VALUE at parse time — `$('scRefresh').onclick=loadScenes`, `filtWire('scSearch',renderScenes)`
// plus three `addEventListener`s, `$('scJoinGap').addEventListener('input',renderJoinTray)`, and
// `document.addEventListener('keydown',scSeekKey)`. A module is deferred, so a page-side read of
// any of them at parse time is `undefined` and kills every top-level statement after it.
//
// 📌 Every one of those wiring statements sat INSIDE the range and traveled with the function,
// which is the fix §11.8 prefers and the reason no arrow was needed: inside the module the
// declaration is hoisted and resolves locally, leaving nothing deferred behind in the page. That
// is thirteen names off the pin now, eleven of them this way.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT REACHES OUTWARD — nineteen imported names, none read off the page.
//
// ⚠️ THE COUNT WAS "twelve … three read off the page" AND BOTH HALVES WENT STALE WITHOUT ANYONE
// EDITING THEM. `filtWire` and `switchStTab` became real imports during 7.3 (their own notes below
// record it) and 7.5 adds four more for 🎓 Train, so the paragraph beginning "switchTab and
// switchStTab are inline FUNCTION declarations" describes an arrangement that no longer exists —
// it is kept because the REASONING in it is still the reason those names may be reached at all.
// 📌 The lesson is §11.10's: a header names what its author was writing that day. Check it against
// the import block, which is nine lines down and cannot lie.
//
// `switchTab` and `switchStTab` are inline FUNCTION declarations (✎ Edit in Playground changes
// tab; Apply returns to Clips) and `filtWire` is the one `util/filter.js` deliberately left in the
// page (§11.2). A module's scope chain reaches the classic script's top-level declarations and the
// classic script always runs first, so reading them costs nothing (§11.4's last note) — all three
// become imports when `ui/tabs.js` lands at m2 and `filtWire` follows it.
//
// 🔴 `stFaceFor` / `stLoadFaces` ARE THE m11b PREDICTION COMING TRUE. st/chars.js's header says
// its Character-column pair "stop being read off the shim and become an ordinary module-to-module
// import when §5's m7 moves the scenes family". This is that import. m4i/§9a.3 reused m4h's card
// join rather than reimplementing "whose voice is this?" twice, and the two halves are now in two
// modules with one arrow between them instead of two implementations drifting apart.
// 📌 11.2.6: the Clips row now imports `stSceneFaceFor` instead of `stFaceFor` — same index, but it
// picks among same-named documents where the voice list must refuse (see st/chars.js).
//
// ⚠️ `enh` is `sys/enhance.js`'s availability state, shared with the Playground and Book Enhance
// controls, and it is imported rather than copied precisely so there is ONE answer in the page to
// "can this box enhance?" — a real `import` IS a live binding, unlike the shim.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ tests/clips_ui_smoke.mjs SLICES THIS FILE AND RUNS IT IN A BARE vm — `const scLib={` through
// `$('scRefresh').onclick=loadScenes;`, 93 checks. It was converted to `tests/_websrc.mjs` in this
// commit, so the slice follows the code across files and a missing marker throws with its own name
// in the message instead of quietly becoming the rest of the file (§3.5, landmine 7). The vm has
// no `document`, which is why `scSeekKey`'s listener is registered further down with the other
// handlers rather than beside the function — that comment is at its original site and still true.
import { $, esc, scrollUnderStick, stickTop } from '../util/dom.js';
import { switchTab } from '../ui/tabswitch.js'; // 7.3-m13
import { jget, jpost, fetchUnlocked } from '../util/http.js';
import { modal } from '../ui/modal.js';
// ✅ `filtWire` JOINED THIS LINE AT 7.3-m13. This file has always wired its OWN filter box —
// `filtWire('scSearch',renderScenes)` down at the Clips list — and until now it reached the page's
// copy through the global scope chain, because `util/filter.js` deliberately left `filtWire` behind
// at m1b. 📌 So the Clips box is the TENTH filter box, and it is the only one that was never in
// index.html's `── every filter box ──` block: it wires itself, beside the renderer it drives,
// which is where the other nine would live if their features had been written this way.
// ⚠️ Note it passes `renderScenes` as a BARE VALUE, not an arrow. In the page that would have been
// the §11.8 TDZ bug; in a module the import is resolved before this body runs, so it is correct
// here and always was.
import { filtRows, filtWire } from '../util/filter.js';
import { fmtDate, fmtDur, fmtEta, fmtSize } from '../util/fmt.js';
import { UIS } from '../util/uistate.js'; // 8.2.4 — the enhancement queue survives a reload
import { enh } from '../sys/enhance.js';
import { stSceneFaceFor, stLoadFaces } from '../st/chars.js';
// ⚠️ `switchStTab` STOPPED BEING AN INLINE READ AT 7.3-m2b, so it is an import — one of the three
// names the header below still lists as "read off the page" and the first of them to move. Apply
// (✎ Edit in Playground's return trip) calls it to come back to the Clips sub-tab.
// ✅ `switchTab` IS IMPORTED NOW, FROM js/ui/tabswitch.js — 7.5.6. This note used to say it must
// never be, and it was right about the hazard and wrong about the only way out: importing it from
// `ui/tabs.js` WOULD be a cycle, because that file imports `loadScenes` from this one.
// ⚠️ STILL TRUE: never import it from `ui/tabs.js`. The mechanism moved to a leaf that imports no
// feature at all, which is what makes both directions legal — `tabswitch.js` exists so that nobody
// has to keep avoiding this edge by hand, as the bare read used to.
import { switchStTab } from '../st/tabstate.js'; // 7.5.6 — the leaf; st/tabs.js would be a cycle
// Shared source preparation adds scene and Playground clips to the Speech library.
import { spLoadAll } from '../media/speech.js';
import { switchStudioPanel } from '../media/studio-tabs.js';
// ── Clips tab (6.0 §7): audio scenes ────────────────────────────────────
// m1 lists SCENES only; m2 adds playground clips and uploads alongside them, plus Join.
// Modeled on the Playground library panel deliberately — same header idiom, same
// selection-plus-two-buttons shape, same form-POST download — because they are the same kind
// of list and a second set of conventions would be a second thing to learn.
// 6.0-m2 §7. `sel` is an ARRAY, not a Set, and that is the feature: "default order is the
// order ticked, arrows fix the rest", so tick order IS the join order and a Set would throw it
// away. It holds the row objects so the running total needs no second lookup.
//
// 🔴 IDENTITY IS THE (kind, ref) PAIR. The three stores have independent namespaces and a name
// genuinely repeats across them — a scene and an upload can both be "hello". Every membership
// test, every checkbox and every payload goes through scKey().
//
// 6.1 §10.3 adds `open` — the ref of the ONE scene whose chapters are expanded — and `chap`,
// its fetched entries. 🔴 Both live here rather than in the DOM because renderScenes() rebuilds
// #scList from scratch from six call sites, and an expansion held only in the markup dies on
// the two that will actually happen: he types in Search, or he hits ↻ Refresh. Exactly why
// `sel` is state and not a set of checked boxes.
//
// 6.1-m1b adds the edit staging: `clip` is the clipboard, `edits` maps a scene ref to its
// ordered staged plan, `origin` remembers where ✎ Edit in Playground departed from, and `full`
// is the one chapter row showing its whole text.
//
// 🔴 The staged plan lives HERE and nowhere else (§3.2). There is no edit-session resource on the
// server: an abandoned edit should evaporate, and a server-side draft would need expiry,
// ownership and cleanup to achieve what closing a tab already does. Apply posts the whole ordered
// plan in one request, so the payload is the whole truth and the server re-derives nothing — the
// same rule Join follows. ⚠️ The cost is that a reload loses staged edits, which is accepted:
// staging batches a few edits in one sitting, it is not meant to be resumable work.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 8.3 — the types. Measured off the ROUTE, per types/vocalis.d.ts's own rule: `clip_sources.py`'s
// three `_..._rows()` for a row, `scenes.py`'s manifest `entries` for a chapter, the two scene
// routes' job dataclasses for a poll answer. Local to this file — none of it is shared, so none
// of it belongs in types/vocalis.d.ts (§11.2's fan-out rule: shared vocabulary is frozen there
// before the fan-out, everything else is this file's own business).

/** @typedef {'scene'|'playground'|'upload'} SceneKind */

/** One flattened catalog row returned by `/clips/items`. `kind` identifies its source store; fields are optional when a source does not provide them.
 * @typedef {Object} SceneRow
 * @property {SceneKind} kind
 * @property {string} ref
 * @property {string} name
 * @property {number|null} [duration_s]
 * @property {number} [size]
 * @property {number} [created_ts]
 * @property {string|null} [created] - ISO timestamp when provided; null for uploads
 * @property {boolean} [enhanced]
 * @property {string} [raw_ref] - source scene for an enhanced scene
 * @property {string} [origin] - owner, voice, or upload provenance
 * @property {number} [n_entries]
 * @property {number} [n_skipped]
 * @property {string[]} [characters]
 * @property {string[]} [character_avatars]
 * @property {string} [chat] - searchable scene metadata, not displayed
 * @property {string} audio_url
 * @property {boolean} [favorite] - added by `clip_favorites.for_rows`
 */

/** One scene manifest entry: a source chat message or an inserted/replacement edit.
 * @typedef {Object} SceneEntry
 * @property {number|null} [mesid] - null for inserted or replaced entries
 * @property {string} [character]
 * @property {string} [voice] - server-recorded voice value
 * @property {string} [cache_key] - absent when replaced audio is removed
 * @property {number} [chars]
 * @property {number} [duration_s]
 * @property {number} [offset_s]
 * @property {string} [text]
 * @property {boolean} [inserted]
 * @property {{kind:string,ref:string}} [replaced_with]
 * @property {{kind:string,ref:string}} [source_clip]
 */

/** @typedef {'replace'|'insert_before'|'insert_after'} SceneEditVerb */

/**
 * One staged edit — the client's own shape, one field richer than the wire payload
 * (`scApplyEdits` strips `name` before POSTing): `name` is what the ✕/paste tooltips show.
 * @typedef {Object} SceneEditOp
 * @property {SceneEditVerb} op
 * @property {number} index
 * @property {string} kind
 * @property {string} ref
 * @property {string} name
 * @property {string} text
 */

/** A staged op tagged with its position in `scLib.edits[ref]` — what the ✕ unstage buttons' `data-unstage` index points at. @typedef {SceneEditOp & {n:number}} SceneStagedOp */

/** @typedef {Object} SceneChapterRow
 * One flattened chapter-list row: a staged clip or an original scene entry, which may be replaced.
 * @property {SceneStagedOp} [ins]
 * @property {SceneEntry} [e]
 * @property {number} [i]
 * @property {SceneStagedOp} [rep]
 */

/** @typedef {{kind:string,ref:string,name:string}} SceneClip - the edit-staging clipboard (6.1-m1b) */
/** @typedef {{ref:string,index:number,title:string}} SceneOrigin - where ✎ Edit in Playground departed from */
/** @typedef {{kind:string,ref:string}} ScenePlaying - which row's `<tr class="scPlay">` to render */
/** @typedef {{job:string,text:string,pct:(number|null)}} SceneEnhJob - one row's live enhancement (8.2.4's queue pump writes these; 9.2.1 adds the bar's percentage, null when there is no honest one) */

/**
 * The one `<audio>` element in this tab (§10.4/§10.5), widened with the expandos `scSeekPlay`
 * parks on it. Not a `VEl` lie — `HTMLAudioElement` is the real element `scEnsurePlayer` creates;
 * `_seek`/`_seekArmed` are this app's own convention (§ Element's expandos in types/vocalis.d.ts),
 * just not ones worth freezing into that shared file for one local player.
 * @typedef {HTMLAudioElement & {_seek?:number, _seekArmed?:number}} SceneAudioEl
 */

/** Mutable state for the Clips tab. Keep the object identity stable because the page shim exposes a one-time copy. `editJob` is added only after Apply starts; keep polling handles local to their closures.
 * @typedef {Object} SceneLib
 * @property {SceneRow[]} items
 * @property {SceneRow[]} sel - tick order is join order
 * @property {string|null} open - expanded scene reference
 * @property {Record<string, SceneEntry[]>} chap - lazily fetched manifests
 * @property {SceneAudioEl|null} au - shared audio element
 * @property {string|null} auKey - `${kind}|${ref}` for the audio owner
 * @property {ScenePlaying|null} playing
 * @property {Record<string, SceneEnhJob>} enh
 * @property {SceneClip|null} clip - edit staging clipboard
 * @property {Record<string, SceneEditOp[]>} edits - staged operations in apply order
 * @property {SceneOrigin|null} origin
 * @property {string|null} full - expanded chapter key `${ref}|${i}`
 * @property {string} editName
 * @property {string[]} enhQ - queued refs in request order
 * @property {string} enhWait
 * @property {Record<string, string>} enhFail
 * @property {number} enhDone
 * @property {string[]} enhStarting
 * @property {number} enhLimit
 * @property {string} [editJob] - in-flight Apply job id
 * @property {string} sort
 * @property {number} dir - +1 ascending, -1 descending
 */
/** @type {SceneLib} */
export const scLib = {
  items: [],
  sel: [],
  open: null,
  chap: {},
  au: null,
  auKey: null,
  playing: null,
  enh: {},
  clip: null,
  edits: {},
  origin: null,
  full: null,
  editName: '',
  // 8.2.4 — the enhancement queue. `enhQ` is refs in the order they were asked for,
  // `enhWait` is the sentence explaining why the head has not started, and `enhFail`
  // collects terminal refusals so an overnight run reports them in one place instead
  // of stacking modals over a sleeping user. See scEnhQueue.
  enhQ: [],
  enhWait: '',
  enhFail: {},
  // 9.2.1 — reset when a new batch begins (scEnhQueue), never while one is draining, so
  // "3 done" always means "of the run you are watching" rather than "since you opened the tab".
  enhDone: 0,
  // 11.2.7 — all of the above is now a MIRROR of the server's queue (`scene_enhance_queue`),
  // refreshed by `scEnhSync`. The tab no longer decides anything about the queue; it shows it
  // and sends changes to it.
  enhStarting: [],
  enhLimit: 0,
  // 9.5.7 — the column order. `created_ts` descending is what `/clips/items` already answers
  // (clip_sources.py sorts newest-first before it replies), so the default is the order this
  // list has had since 6.0 rather than a new one that would move every row the day it shipped.
  // Overwritten by `scSortRestore()` at module load — see the wiring at the foot of this file.
  sort: 'created_ts',
  dir: -1,
};
/** @param {SceneRow} s */
const scKey = s => `${s.kind}|${s.ref}`;
/** @param {SceneRow} s */
const scHas = s => scLib.sel.some(x => scKey(x) === scKey(s));

// 🔴 ONLY THE NEWEST LOAD MAY ASSIGN. `loadScenes` is called from seven places — the tab switch
// (fire-and-forget, not awaited), ↻ Refresh, and the completion of an enhance, an edit and a
// join — with nothing stopping two being in flight at once, and `scLib.items=` used to run
// whenever each one happened to come back. The LAST to resolve won, which is not the last to be
// asked for, so an older answer could overwrite a newer one and then sit there until something
// else refreshed.
//
// What that cost: switch to Clips and the tab-switch load starts; anything that starts a second
// load before it lands (Refresh, or the reload the browser spec does) races it. Star a row in
// between and the stale answer replaces `scLib.items` with rows fetched BEFORE the star — every
// one of them `favorite:false`, and the row the click handler is holding no longer in the
// array at all. Tick "★ favorites only" and the list is empty, and STAYS empty, while the
// server has the star and a reload shows it. Found by the 6.4 session as an intermittent
// browser-spec failure (~1 in 3) and handed over; this is the cause.
let scLoadSeq = 0;
// 🔴 AND A LOAD IS STALE IF A WRITE LANDED WHILE IT WAS IN FLIGHT, not only if a newer LOAD did.
// `scLoadSeq` above orders loads against LOADS. Nothing ordered a load against a MUTATION, and that
// is the hole the 6.4 fix left open: `/clips/items` is answered BEFORE the star is written, the star
// is then written and CONFIRMED, and only then does that older-but-still-newest answer arrive. It
// passes the sequence guard — no newer load exists — and assigns rows that are every one of them
// `favorite:false`. Tick "★ favorites only" and the list renders empty and STAYS empty while the
// server holds the star.
//
// That is the failure `tests/clips_favorites_browser_spec.mjs` records as
// "KNOWN INTERMITTENT FAILURE, UNDIAGNOSED", down to the detail that made it look unlike a race:
// the list does not flicker and recover, it settles EMPTY, because the losing write is the one that
// already went to the server. ⚠️ The hypothesis logged beside it there — a detached `row` object —
// was a DIFFERENT defect, and it is the one already fixed by the re-find in the `fav` handler below.
// Both were live; fixing one left this intact and left the spec still red about 1 run in 3.
//
// Bumped on the CLICK and again on the ANSWER, so any load whose response could predate a completed
// write is discarded rather than believed. ⚠️ Discarding cannot strand the list: it re-asks, and the
// re-ask is issued after the write by construction, so it terminates as soon as no write is in
// flight. Returning stale rows and waiting for something else to refresh is what caused this.
let scFavSeq = 0;
export async function loadScenes() {
  const seq = ++scLoadSeq;
  const mut = scFavSeq;
  let items,
    ok = true;
  // m4i / §9a.3 — the faces the Character column draws, joined by name exactly as the Character
  // Voices list does (m4h). Raced alongside the rows rather than queued in front of them, and
  // `stLoadFaces` swallows its own errors, so a locked vault costs initials and never the tab.
  //
  // 11.2.5 — and SillyTavern's own character list, for the scenes that predate the avatar being
  // stored on the scene. Its own `.catch`, because it is a decoration: a failure costs the old
  // name-only lookup, never the rows.
  try {
    [items] = await Promise.all([jget('/clips/items'), stLoadFaces(), scLoadStAvatars()]);
  } catch (e) {
    items = [];
    ok = false;
  }
  if (seq !== scLoadSeq) return; // a newer load overtook this one — its answer wins
  if (mut !== scFavSeq) return loadScenes(); // a star was written while this was in flight — re-ask
  scLib.items = items;
  // Drop anything that has gone from the store since it was ticked, or Join posts a ref the
  // server will refuse — and it refuses the WHOLE join by name, deliberately (§9).
  const live = new Set(scLib.items.map(scKey));
  scLib.sel = scLib.sel.filter(s => live.has(scKey(s)));
  // Same for the expansion: a scene deleted in another tab must not leave a detail row hanging
  // off a row that is no longer there.
  if (scLib.open && !scLib.items.some(s => s.kind === 'scene' && s.ref === scLib.open)) scLib.open = null;
  // 8.2.4 — restore a saved queue ONCE, on the first load that has rows to validate it against.
  // ⚠️ Not on every call: loadScenes runs again after each enhancement finishes, and re-reading
  // the saved list there would resurrect items the pump had just consumed.
  // 🔴 AND ONLY ON A GOOD FETCH. A transient 500 on the first `/clips/items` used to latch the
  // restore against an EMPTY list — scEnhRestore then pruned every saved ref as "not live" and
  // WROTE the empty queue back, permanently erasing an overnight list over one dropped socket.
  // Same rule vsLoadPg spells out: prune the bench only on a fetch that succeeded.
  if (!scEnhRestored && ok) {
    scEnhRestored = true;
    scEnhRestore();
    scEnhSync();
  }
  renderScenes();
}

function scFiltered() {
  // `chat` is matched but not shown — the m1 list searched it and the placeholder still
  // promises it, so dropping it from the accessor would narrow the search silently.
  let a = filtRows('scSearch', scLib.items, s => `${s.name} ${s.origin || ''} ${s.chat || ''} ${s.kind}`);
  const k = /** @type {HTMLSelectElement} */ ($('scKindFilter')).value; // §7 — which store
  if (k) a = a.filter(s => s.kind === k);
  // m4i / §9a.3 — who speaks in it. A scene matches if ANY of its speakers is the one picked:
  // "show me the clips with Cleo in them" is the question, and a two-hander is still a Cleo clip.
  const who = $('scCharFilter') ? /** @type {HTMLSelectElement} */ ($('scCharFilter')).value : '';
  if (who === SC_NO_CHAR) a = a.filter(s => !(s.characters || []).length);
  else if (who) a = a.filter(s => (s.characters || []).includes(who));
  const f = /** @type {HTMLSelectElement} */ ($('scEnhFilter')).value; // §7.1 — three-state
  if (f === '1') a = a.filter(s => !!s.enhanced);
  else if (f === '0') a = a.filter(s => !s.enhanced);
  if (/** @type {HTMLInputElement} */ ($('scFavOnly')).checked) a = a.filter(s => !!s.favorite); // 6.2 — additive to both of those
  return scSorted(a);
}

// ── 9.5.7 / the column sort ───────────────────────────────────────────────────
//
// 🔴 A DERIVED VALUE PER COLUMN, NOT A FIELD LOOKUP. The Playground's sort (`pgFiltered`)
// indexes the row object by the header's own name, which it can do because all five of its
// sortable columns ARE fields. Two of this table's are not: **Character** renders
// `characters[0]` out of an array, and **Length** is `duration_s` under a header that says
// something else. A `Record<string,…>` lookup copied over from there would have read
// `undefined` for every row in the Character column — one arbitrary order, a live arrow, and
// nothing on screen to say it had not sorted.
//
// ⚠️ A ROW WITH NOTHING IN THE COLUMN SINKS, IN BOTH DIRECTIONS. Three of the six columns are
// genuinely absent on some kinds — an upload has no origin worth reading, a Playground clip has
// no character, and a scene built before m4i has neither — and `clip_sources.py` writes
// `created_ts: 0.0` rather than null when it cannot date something. Letting those compare as
// `''`/0 parks them at the TOP of an ascending sort, which is the one place a row whose value
// you cannot see is most confusing. They go to the bottom whichever way the arrow points.
//
// ⚠️ AND THE ORDER IS TOTAL, because this list re-renders on its own. `name` is the tie-break,
// so two scenes built in the same second cannot swap places when an enhancement finishing
// somewhere else triggers a repaint — a row moving under the cursor is how a mis-click happens.

/** Which columns the header row offers, in the order they are drawn. @type {string[]} */
const SC_SORT_COLS = ['who', 'name', 'kind', 'origin', 'created_ts', 'duration_s'];

// Descending first for the two columns where "most" is the interesting end — newest scene,
// longest clip — and ascending first for the four that read as words. Same split the Playground
// makes, and it is why one click on Built is useful rather than showing you the oldest thing.
const SC_SORT_DESC_FIRST = new Set(['created_ts', 'duration_s']);

/**
 * The value one column sorts on. `null` means "this row has nothing in this column", which is a
 * different answer from an empty string and is what `scSorted` sinks to the bottom.
 * @param {SceneRow} s
 * @param {string} k - a `<th data-sort>` name
 * @returns {string|number|null}
 */
function scSortVal(s, k) {
  switch (k) {
    // The face cell draws the FIRST speaker and a count of the rest (`scWhoCell`), so that is
    // what this column sorts by. Sorting on the whole cast would order a two-hander by a name
    // the column never shows.
    case 'who':
      return (s.characters || [])[0] || null;
    case 'name':
      return s.name || null;
    case 'kind':
      return s.kind || null;
    case 'origin':
      return s.origin || null;
    // 🔴 `created_ts`, NEVER the `created` STRING beside it in the cell. All three kinds carry a
    // numeric `created_ts` (an upload's is its mtime), while `created` is null on an upload and
    // an ISO-ish string on the other two — so sorting the visible text would compare a string
    // against a null for a third of the rows, and would break the day the format changed.
    case 'created_ts':
      return s.created_ts || null; // 0.0 is clip_sources.py's "no date", not the epoch
    case 'duration_s':
      return s.duration_s || null;
    default:
      return null;
  }
}

/**
 * The filtered rows in the order the header row says. A COPY: `filtRows` hands back the array
 * it was given when nothing is typed in the box, so this can be `scLib.items` itself — and
 * sorting that in place would reorder the store on every render, which would look like the
 * sort working while quietly destroying the server order everything else here reads.
 * @param {SceneRow[]} a
 * @returns {SceneRow[]}
 */
function scSorted(a) {
  const k = SC_SORT_COLS.includes(scLib.sort) ? scLib.sort : 'created_ts',
    d = scLib.dir < 0 ? -1 : 1;
  return a.slice().sort((x, y) => {
    const vx = scSortVal(x, k),
      vy = scSortVal(y, k);
    if ((vx === null) !== (vy === null)) return vx === null ? 1 : -1; // blanks last, both ways
    const c =
      vx === null ? 0 : typeof vx === 'string' || typeof vy === 'string' ? String(vx).localeCompare(String(vy)) : Number(vx) - Number(vy);
    // 🔴 `c * d || tie`, NOT `(c || tie) * d` — the direction belongs to the COLUMN, never to the
    // tie-break. Flipped with it, every row that ties turns over as well: the whole undated block
    // of a `Built` sort reverses when you click the arrow, which reads as the sort scrambling
    // rows it should not have touched. Measured on the layout fixture, whose three scenes share
    // one timestamp and therefore ARE that block — under the flipped form the first row on screen
    // changed identity with the arrow.
    return c * d || String(x.name || '').localeCompare(String(y.name || ''));
  });
}

/**
 * Take a header click: a new column starts at its natural end, the same column flips.
 * @param {string} k
 * @returns {boolean} false when `k` is not a column, so a caller can fall through
 */
function scSortBy(k) {
  if (!SC_SORT_COLS.includes(k)) return false;
  if (scLib.sort === k) scLib.dir *= -1;
  else {
    scLib.sort = k;
    scLib.dir = SC_SORT_DESC_FIRST.has(k) ? -1 : 1;
  }
  scSortSave();
  renderScenes();
  return true;
}

// The order follows the ACCOUNT, like `vSort` in Character Voices and unlike the Playground's,
// which forgets on every reload. 🔴 THE `vocalis-` PREFIX IS LOAD-BEARING: `ui_state.sanitize`
// keeps only keys that have it, so an unprefixed name is dropped at `/ui-state` with no error
// anywhere — and reads keep working out of UIS's in-memory copy until the page reloads, which is
// what hid exactly this defect in `sc-enhq` for five milestones (9.5.6). `test_ui_state.py`
// reads these names out of the modules and puts them through the real filter.
const SC_SORT_KEY = 'vocalis-sc-sort';
function scSortSave() {
  try {
    UIS.setItem(SC_SORT_KEY, `${scLib.sort}|${scLib.dir}`);
  } catch (e) {}
}
// ⚠️ CALLED FROM OUTSIDE THE SLICE, at the foot of this file with the other wiring. Everything
// from `scLib` down to `$('scRefresh').onclick` is cut out and run in a bare vm by
// tests/clips_ui_smoke.mjs, whose default sandbox has no `UIS` — a module-level call in here
// would throw a ReferenceError before the first of its ninety-odd checks ran.
function scSortRestore() {
  let raw = '';
  try {
    raw = UIS.getItem(SC_SORT_KEY) || '';
  } catch (e) {
    return;
  }
  const [k, d] = raw.split('|');
  if (!SC_SORT_COLS.includes(k)) return; // a column since renamed, removed, or never written
  scLib.sort = k;
  scLib.dir = d === '-1' ? -1 : 1;
}

// ── m4i / §9a.3: whose voice is this? ────────────────────────────────────────────────────────
//
// 📌 **THE EXTENSION HALF WAS ALREADY DONE.** §9a.3 opens "this one starts at the EXTENSION… the
// character who spoke it is not sent, so there is nothing in the store to render or filter on."
// Not so: `scene_build.py` has written `character` onto every scene entry since the first build.
// The names were in the manifest the whole time; `scenes._speakers` just had to surface them
// without shipping the transcript with them.
//
// 🔴 A SENTINEL THE DROP-DOWN CAN CARRY, and it must not be a name a character could have. The
// empty string is already "all", so "no character" needs its own value — and a bare "unknown"
// would filter to nothing the day somebody names a character Unknown.
//
// ⚠️ VISIBLE CHARACTERS, NOT A CONTROL CODE. This was written as a NUL-prefixed string twice in
// one night — see `WB_SET_SKIP` — and both times it put a literal NUL into this file, which is
// what makes grep declare index.html binary and refuse to search it.
// `~` cannot start a SillyTavern character name that reaches here, and it is greppable.
const SC_NO_CHAR = '~none';

// 11.2.5 — display name (lowercased) → SillyTavern avatar filename, from the Character Voices
// registry. `null` marks a name two SillyTavern characters share: the same "looked and must not
// choose" rule as `stFaces.byName`. Only consulted for a scene that did not record the avatar.
/** @type {Record<string, string|null>} */
let scStAvatars = {};
function scLoadStAvatars() {
  return jget('/st/characters').then(
    /** @param {{characters?: Record<string, {name?: string, avatar?: string}>}} r */ r => {
      /** @type {Record<string, string|null>} */
      const m = {};
      for (const [key, e] of Object.entries((r && r.characters) || {})) {
        const k = ((e && e.name) || key).trim().toLowerCase();
        if (!k || !e || !e.avatar) continue;
        m[k] = k in m ? null : e.avatar;
      }
      scStAvatars = m;
    },
    () => {
      scStAvatars = {};
    },
  );
}

// One face for a row: the first speaker, plus how many others there are. ⚠️ NOT one face per
// speaker — a six-hander would be six circles in a column sized for one, and the row's job is to
// answer "whose clip is this" at a glance rather than to list the cast.
/** @param {SceneRow} s */
function scWhoCell(s) {
  const who = s.characters || [];
  if (!who.length) {
    return (
      '<td class="small muted" title="No character recorded. Playground clips are voice ' +
      'auditions rather than a character speaking, and scenes built before this was stored ' +
      'have none.">—</td>'
    );
  }
  const extra = who.length - 1;
  const tip = who.length === 1 ? who[0] : who.join(', ');
  // 🔴 20px, NOT the 34 the Character Voices list uses, AND THE SIZE IS LOAD-BEARING. This is a
  // dense table whose row height is set by its tallest cell, so a bigger circle makes every row
  // taller — at 34 it pushed the fifth scene's Chapters button below the fold and failed a
  // browser check that has nothing to do with this feature, reporting a row-height change as a
  // chapters bug. 20px matches the table's own line box, so the rows are exactly as tall as they
  // were before this column existed. A table of clips is SCANNED; a voice list is worked in.
  return (
    '<td><div style="display:flex;align-items:center;gap:7px" title="' +
    esc(tip) +
    '">' +
    scFaceFor(s, who[0]) +
    '<span style="min-width:0"><span class="small scWhoName">' +
    esc(who[0]) +
    '</span>' +
    (extra ? '<span class="small muted"> +' + extra + '</span>' : '') +
    '</span></div></td>'
  );
}

// 🔴 11.2.5 — THE FACE IS FOUND BY SILLYTAVERN'S AVATAR FILENAME, NOT THE NAME. Name-only lookup
// can fail when multiple library documents share a character name. This passed `{}` to
// `stFaceFor`, which made it a name-only lookup, and a name that
// two library documents answer to (a persona and a card, a re-imported card) is one it refuses to
// guess at. The Character Voices list never had the problem because it passes the avatar.
// The scene records it now; an older scene borrows it from that same list when the name is
// unique there. 11.2.6: and when neither finds a document, `stSceneFaceFor` picks the best library
// document of that name instead of refusing — see its comment in st/chars.js.
/**
 * @param {SceneRow} s
 * @param {string} name
 */
function scFaceFor(s, name) {
  const av = (s.character_avatars || [])[0] || scStAvatars[name.trim().toLowerCase()] || '';
  return stSceneFaceFor(name, av, 20);
}

// The drop-down's options, from the rows actually loaded. Rebuilt on every render because a
// Refresh, a delete or a new scene all change who is present — and the current selection is
// preserved so a repaint does not silently widen the filter he set.
function scSyncCharFilter() {
  const sel = /** @type {HTMLSelectElement} */ ($('scCharFilter'));
  if (!sel) return;
  const names = new Set();
  let anyNone = false;
  (scLib.items || []).forEach(s => {
    const w = s.characters || [];
    if (!w.length) anyNone = true;
    w.forEach(n => names.add(n));
  });
  const want = sel.value;
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const opts = ['<option value="">all</option>'].concat(sorted.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>'));
  if (anyNone) opts.push('<option value="' + SC_NO_CHAR + '">no character</option>');
  sel.innerHTML = opts.join('');
  // 🔴 IF THE NAME HE PICKED IS GONE, FALL BACK TO "all" — never to whatever option happens to
  // sit at that index. Deleting the last Cleo clip while filtered to Cleo must show everything,
  // not silently re-point the filter at Bianca.
  //
  // ⚠️ Decided from the values just BUILT, not by reading `sel.options` back. Re-reading the DOM
  // to learn something this function already knows is a needless dependency on it — and it broke
  // `clips_ui_smoke.mjs`, which runs these helpers against a stub element whose `options` is not
  // iterable. The stub was right to object: the answer was in hand.
  const valid = want === '' || (want === SC_NO_CHAR && anyNone) || names.has(want);
  sel.value = valid ? want : '';
}

/** @type {Record<SceneKind, string>} */
const SC_KIND_PILL = {
  scene: '<span class="pill" title="Built here from a range of chat messages.">scene</span>',
  playground: '<span class="pill" title="A Playground render. Rename or delete it in the Playground tab.">playground</span>',
  upload:
    '<span class="pill" title="From the Speech store — an upload, a Playground import or a stem-split vocal. Manage it in the Speech tab.">upload</span>',
};

/** @param {number|null|undefined} s */
function scFmtDur(s) {
  if (s == null) return '';
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  const m = Math.round(t / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── §10.3 / §10.4 — chapters inline, with the scene's player inside the same row ──────────
//
// The expanded row is an ordinary detail-row accordion: one <tr> immediately after the scene's
// own, holding a single td that spans all SEVEN columns (checkbox, Name, Kind, From, Built,
// Length, actions). Its player is the point as much as its chapters are — a chapter link seeks
// something two inches above it rather than a control at the top of the section that may itself
// be off screen by the time you have scrolled down to the row you wanted.
// The chapter list as a flat list of ROWS — the original entries in order, with staged inserts
// spliced in where they will land. That is the point of staging rather than applying one at a
// time: what he reads is the running order he is going to get.
/** @param {string} ref */
function scChapterRows(ref) {
  const ch = scLib.chap[ref] || [],
    ops = scLib.edits[ref] || [];
  /** @type {Record<number, SceneStagedOp>} */
  const repl = {};
  /** @type {Record<number, SceneStagedOp[]>} */
  const before = {};
  /** @type {Record<number, SceneStagedOp[]>} */
  const after = {};
  ops.forEach((o, n) => {
    if (o.op === 'replace') repl[o.index] = { ...o, n };
    else if (o.op === 'insert_before') (before[o.index] = before[o.index] || []).push({ ...o, n });
    else (after[o.index] = after[o.index] || []).push({ ...o, n });
  });
  /** @type {SceneChapterRow[]} */
  const rows = [];
  ch.forEach((e, i) => {
    (before[i] || []).forEach(o => rows.push({ ins: o }));
    rows.push({ e, i, rep: repl[i] });
    (after[i] || []).forEach(o => rows.push({ ins: o }));
  });
  return rows;
}

/** @param {SceneRow} s */
function scDetailRow(s) {
  const ch = scLib.chap[s.ref];
  if (ch === undefined)
    return `<tr class="scDet" data-detref="${esc(s.ref)}"><td colspan="9" style="background:rgba(127,127,127,.07)">
      <span class="small muted">Loading chapters…</span></td></tr>`;
  const ops = scLib.edits[s.ref] || [],
    clip = scLib.clip;
  const body = ch.length
    ? `<div style="overflow-x:auto"><table class="pgtable"><tbody>` +
      scChapterRows(s.ref)
        .map(r => {
          if (r.ins)
            return `<tr class="scStaged scStagedIns">
        <td style="width:70px" class="small muted">＋</td>
        <td style="width:120px" class="small muted">inserted</td>
        <td class="small"><b>${esc(r.ins.name)}</b><span class="muted"> — ${r.ins.op === 'insert_before' ? 'before' : 'after'} line ${r.ins.index + 1}</span></td>
        <td style="width:104px;white-space:nowrap"><button class="xs danger" data-unstage="${r.ins.n}" title="Take this edit off the plan">✕</button></td></tr>`;
          const e = /** @type {SceneEntry} */ (r.e),
            i = r.i,
            rep = r.rep;
          const txt = String(e.text || ''),
            long = txt.length > 160;
          const shown = scLib.full === `${s.ref}|${i}` || !long ? txt : txt.slice(0, 160) + '…';
          // §5.2 — an inserted entry has no mesid, so the Chapters list needs a row shape that
          // renders without one. This is the single place in the feature where existing UI had to
          // CHANGE rather than gain a button.
          const who = e.inserted ? 'inserted' : e.character || '';
          return `<tr${rep ? ' class="scStaged scStagedRep"' : ''}>
        <td style="width:70px"><a href="#" data-seek="${e.offset_s}" title="Jump to this message — starts playing if it is not already">${scFmtDur(e.offset_s)}</a></td>
        <td style="width:120px" class="small muted">${esc(who)}</td>
        <td class="small"><span data-fulltext="${i}"${long ? ' style="cursor:pointer" title="Show the whole line"' : ''}>${esc(shown)}</span>
          ${rep ? `<div class="small" style="margin-top:3px">↳ <b>${esc(rep.name)}</b> <span class="muted">replaces this line when you Apply</span></div>` : ''}</td>
        <td style="width:104px;white-space:nowrap">${
          rep
            ? `<button class="xs danger" data-unstage="${rep.n}" title="Keep the original line">✕</button>`
            : `${e.text && !e.inserted ? `<button class="xs" data-pgedit="${i}" title="Open this line in the Playground with its text and voice loaded">✎</button>` : ''}${
                clip
                  ? ` <button class="xs" data-paste="insert_before|${i}" title="Paste ${esc(clip.name)} before this line">⇤</button>` +
                    ` <button class="xs" data-paste="replace|${i}" title="Replace this line with ${esc(clip.name)}">⇄</button>` +
                    ` <button class="xs" data-paste="insert_after|${i}" title="Paste ${esc(clip.name)} after this line">⇥</button>`
                  : ''
              }`
        }
        </td></tr>`;
        })
        .join('') +
      '</tbody></table></div>'
    : '<span class="muted">This scene has no recorded entries.</span>';
  // The Apply bar exists only while something is staged. A permanently visible Apply on a scene
  // with no edits is a button that does nothing, and this panel is busy enough already.
  const apply = ops.length
    ? `<div class="row" style="margin-top:8px;align-items:center">
      <div style="flex:1"><input id="scEditName" type="text" placeholder="Name the edited scene…" value="${esc(scLib.editName || s.name + ' (edited)')}" style="width:100%" autocomplete="off"></div>
      <div style="flex:0"><button class="sm primary" id="scEditApply">Apply ${ops.length} edit${ops.length === 1 ? '' : 's'}</button></div>
      <div style="flex:0"><button class="sm danger" id="scEditCancel" style="display:none">Cancel</button></div></div>
    <div class="small muted" style="margin-top:4px">Apply writes a <b>new</b> scene, in seconds — nothing is re-rendered, the clips are stitched into the audio you already have. This scene is left exactly as it is.</div>
    <div id="scEditStatus" class="small muted" style="margin-top:4px"></div>`
    : '';
  return `<tr class="scDet" data-detref="${esc(s.ref)}"><td colspan="9" style="background:rgba(127,127,127,.07)">
      ${body}${apply}</td></tr>`;
}

// ── §10.5 — the player sits in a row of its own, directly under whatever it is playing ────
//
// 🔴 So the slot is no longer "inside the open detail row" — it is its own <tr>, emitted for
// WHICHEVER clip owns the player, of any kind. That is what makes it consistent: a Playground
// clip and an upload have no Chapters button and used to be stuck with the bar at the top of the
// section, which is exactly the complaint. When a scene's chapters are also open the player row
// comes FIRST and the chapters directly under it, so a chapter link still seeks a player two
// inches above it — §10.3's promise, kept by adjacency rather than by nesting.
/** @param {SceneRow} s */
const scOwns = s => !!scLib.playing && scLib.playing.kind === s.kind && scLib.playing.ref === s.ref;

// 🔴 9.6.7 — OWNING THE PLAYER AND MAKING SOUND ARE TWO DIFFERENT FACTS, AND THE BUTTON HAS TO
// SAY WHICH ONE IT IS ABOUT. Playback can end or pause while the row still owns the player.
//
// `scLib.playing` was the only input to that button, and it is set in `scEnsurePlayer` and cleared
// in `scStop` — nowhere else. Nothing listened to the element, so the one way playback ordinarily
// finishes, reaching the end, changed nothing on screen: the row kept a red ■ Stop over a clip
// that had stopped by itself. Pausing on the transport bar had the same shape.
//
//   not the owner        ▶ Play    load it and start
//   owner, sounding      ■ Stop    stop the audio AND put the bar away (§10.5, unchanged)
//   owner, not sounding  ✕ Close   put the bar away — there is nothing to stop
//
// ⚠️ SO THE PRESS IS THE SAME ACTION IN BOTH OWNER STATES, and the click handler is deliberately
// left reading ownership alone. That is what keeps the label honest: ✕ Close is not a third
// behavior, it is the true name of the second one once the audio has run out. An earlier cut of
// this made the finished button ▶ Play-again, which left no action to dismiss the bar after
// playback ended. Replay lives on the transport bar, which already provides that control.
//
// ⚠️ RED IS FOR STOP ONLY. `danger` says "this interrupts something"; closing a finished player
// interrupts nothing, and a red ✕ would be the same overstatement in a new color.
//
// 📌 `ended` is checked as well as `paused`, though the spec sets `paused` on end and either alone
// would do. They are two different claims — "stopped" and "finished" — and asking for both costs
// nothing.
function scSounding() {
  const au = scLib.au;
  return !!(au && scLib.playing && !au.paused && !au.ended);
}

/** @param {SceneRow|{kind?: string, ref?: string}} s */
const scPlayLabel = s => (!scOwns(/** @type {SceneRow} */ (s)) ? '▶ Play' : scSounding() ? '■ Stop' : '✕ Close');
/** @param {SceneRow|{kind?: string, ref?: string}} s */
const scPlayTip = s =>
  !scOwns(/** @type {SceneRow} */ (s))
    ? 'Play this clip'
    : scSounding()
      ? 'Stop, and put the player away'
      : 'Put the player away. Nothing is playing — press ▶ Play to hear it again.';

// Repaint the ▶ / ■ / ✕ buttons WITHOUT re-rendering the list.
//
// 🔴 A RE-RENDER IS NOT AVAILABLE HERE AND THAT IS THE WHOLE REASON THIS EXISTS. `renderScenes`
// rewrites `#scList`, which detaches the one `<audio>`; that is safe only because `scPlace`
// re-appends it synchronously in the same task (see its header). These callers are media events —
// `pause` fires from inside `scStop`'s own teardown — so a re-render from here would re-enter the
// render path mid-teardown for a cosmetic change to two attributes. Painting the buttons in place
// touches nothing else and cannot move the player.
function scPaintPlayButtons() {
  const list = $('scList');
  if (!list) return;
  /** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('button[data-act="play"]')).forEach(b => {
    const s = { kind: b.dataset.kind, ref: b.dataset.ref };
    b.classList.toggle('danger', scOwns(/** @type {SceneRow} */ (s)) && scSounding());
    b.textContent = scPlayLabel(s);
    b.title = scPlayTip(s);
  });
}

/** @param {SceneRow} s */
function scPlayerRow(s) {
  return `<tr class="scPlay" data-playref="${esc(s.ref)}" data-playkind="${esc(s.kind)}">
      <td colspan="9" style="background:rgba(127,127,127,.07);padding-top:6px;padding-bottom:6px">
      <div class="scPlaySlot"></div></td></tr>`;
}

// 🔴 There is exactly ONE <audio> in this tab and it gets MOVED, never duplicated. §10.4 warns
// that two players sounding at once is the kind of thing that ships; the way to make that
// unreachable is to have one element rather than two and a rule about clearing the other.
// §10.5: its slot is the `tr.scPlay` row renderScenes emits under the clip that owns it.
// #scPlayer at the top of the section is only the fallback for when that row is not rendered at
// all — Search or the kind filter can hide the playing clip, and the element has to go SOMEWHERE
// or it leaves the document and playback stops.
//
// 🔴 Re-appending an element that innerHTML has just detached does NOT stop playback — the
// spec's "removed from a document" pause runs after a stable state, so it never fires as long as
// the node is back in the document within the same task. Keep this synchronous: an await
// anywhere between the re-render and the append turns a search keystroke into a dropout.
function scPlace() {
  const au = scLib.au,
    top = $('scPlayer');
  if (!au) {
    if (top) top.style.display = 'none';
    return;
  }
  const slot = /** @type {VEl} */ ($('scList')).querySelector('tr.scPlay .scPlaySlot') || top;
  if (slot && au.parentNode !== slot) slot.appendChild(au);
  // An empty fallback div is 8px of margin and a mystery; only show it when it is really in use.
  if (top) top.style.display = au.parentNode === top ? '' : 'none';
}

/**
 * @param {string} kind
 * @param {string} ref
 * @param {string} url
 */
function scEnsurePlayer(kind, ref, url) {
  let au = scLib.au;
  if (!au) {
    au = scLib.au = document.createElement('audio');
    au.id = 'scAudio';
    au.controls = true;
    au.style.width = '100%';
    au.preload = 'metadata';
    // 🔴 9.6.7 — THE ELEMENT'S OWN EVENTS ARE THE ONLY NOTICE THERE IS. Reaching the end, and
    // pause/play on the transport bar below, all happen without going through any code in this
    // file — which is why the red ■ Stop outlived the audio. Bound here, once, on the one element
    // this tab ever builds (see the note above `scPlace`), so there is nothing to unbind and no
    // way to end up with two sets.
    ['play', 'pause', 'ended'].forEach(ev => /** @type {HTMLAudioElement} */ (au).addEventListener(ev, scPaintPlayButtons));
  }
  const key = `${kind}|${ref}`;
  // 🔴 A new owner means a DIFFERENT row has to exist for the player to sit in, and the ▶/■
  // button on both the old row and the new one has to change. That is a re-render, not a move —
  // scPlace alone would append into a slot the previous owner is still holding.
  if (scLib.auKey !== key) {
    scLib.auKey = key;
    scLib.playing = { kind, ref };
    au.src = url;
    renderScenes();
  } else scPlace();
  return au;
}

// So ▶ Play is a toggle and the row's button says which half you are on. Stop, not pause: the
// bar goes away, and the bar is where pause lives. Dropping the element rather than keeping a
// hidden one also aborts the range request — a 46-minute scene would otherwise carry on
// streaming into a player nobody can see.
function scStop() {
  const au = scLib.au;
  if (au) {
    au.pause();
    au.removeAttribute('src');
    au.load();
    if (au.parentNode) au.parentNode.removeChild(au);
  }
  scLib.au = null;
  scLib.auKey = null;
  scLib.playing = null;
  renderScenes();
}

// Seeking a player that has no metadata yet.
//
// ⚠️ §10.3's write-up claimed a pre-metadata `currentTime` assignment is "dropped or clamped to
// zero", so the chapter link would play from the start on a real 46-minute scene. MEASURED, in
// the browser this runs in: that is NOT what happens. Assigning at readyState 0 sets the media
// element's *default playback start position*, and playback begins there once metadata arrives —
// the naive version lands on the offset correctly. Proven by neutering this function and
// watching clips_chapters_browser_spec.mjs stay green, which is why the spec no longer claims
// that check catches a missing guard.
//
// The wait is kept anyway, because it is honest about what it wants and costs three lines: the
// default-playback-start-position path is a Blink/Gecko behavior, not something every engine has
// always done, and `go()` on `loadedmetadata` needs no such assumption. It is belt-and-braces,
// not the fix for a live defect — do not re-document it as one.
/**
 * @param {SceneAudioEl} au
 * @param {number} t
 */
function scSeekPlay(au, t) {
  au._seek = t;
  const go = () => {
    au.currentTime = /** @type {number} */ (au._seek);
    au.play().catch(() => {});
  };
  if (au.readyState >= 1)
    go(); // HAVE_METADATA — duration is known
  else if (!au._seekArmed) {
    au._seekArmed = 1;
    au.addEventListener(
      'loadedmetadata',
      () => {
        au._seekArmed = 0;
        go();
      },
      { once: true },
    );
  }
}

// ← / → nudge the clip five seconds, 6.1. Scenes and SillyTavern clips use the same audio and
// therefore share the same seek keys. A scene here is made of the same messages, so it gets the same
// keys. The extension has the harder version of this (it must not steal ST's swipe keys); here
// nothing else wants them, and the only rule is not to grab them out of a text field.
//
// ⚠️ The listener itself is registered further down, with the other handlers. Everything from
// `scLib` to `$('scRefresh')` is sliced out and run in a bare vm by clips_ui_smoke.mjs, which
// has no `document` — a top-level addEventListener in here fails the whole smoke.
const SC_SEEK_STEP_S = 5;
/** @param {KeyboardEvent} e */
function scSeekKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const au = scLib.au;
  if (!au || au.paused || !au.parentNode) return; // "if anything is playing"
  // Real `HTMLElement`, not `VEl`: `.isContentEditable`/`.tagName` are both native, so this needs
  // none of dom-permissive's EventTarget widening — see that file's header on why the narrower
  // real type is preferred whenever the DOM already provides one.
  const t = /** @type {HTMLElement|null} */ (e.target);
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
  e.preventDefault();
  // A scene is a finished file, so unlike the extension's live stream there is no buffered edge
  // to respect — only the ends of the clip. Stop a quarter-second short so scrubbing to the tail
  // does not fire `ended` and stop the playback he is scrubbing through.
  const dur = Number.isFinite(au.duration) ? au.duration : null;
  let to = au.currentTime + (e.key === 'ArrowLeft' ? -SC_SEEK_STEP_S : SC_SEEK_STEP_S);
  if (to < 0) to = 0;
  if (dur !== null && to > dur - 0.25) to = Math.max(0, dur - 0.25);
  au.currentTime = to;
}

// ── 6.3 — Enhance, on the row ─────────────────────────────────────────────────────────────
//
// Enhancement is a separate action from scene creation, so the raw scene is stored first and
// remains playable while enhancement runs.
//
// Offered only where it can do something: never on a twin (a second pass over 256 kbps audio),
// and never on a scene that already HAS one. The server refuses both anyway — this is so the
// button is not offered and then answered 409 for a reason nothing on screen explains.
/** @param {string} ref */
const scHasTwin = ref => scLib.items.some(x => x.kind === 'scene' && x.raw_ref === ref);
/** @param {SceneRow} s */
function scEnhCell(s) {
  const live = scLib.enh[s.ref];
  if (live) return scEnhLive(s.ref, live);
  // 🔴 7.5.1 — OFFERED WHENEVER THE ROW IS A **RAW** SCENE, HAVING A TWIN OR NOT.
  //
  // The guard used to be `s.enhanced||scHasTwin(s.ref)`. If a restart interrupted enhancement,
  // the twin's row could say "enhanced" while
  // the raw scene's button was hidden BECAUSE that twin existed — so the one control that could
  // have re-run it was removed on the strength of the record whose accuracy was in question.
  // ✅ SO `scHasTwin` NO LONGER HIDES ANYTHING. It only chooses the wording below, which is the
  // honest place for "there is already one of these": a note, not a locked door. Re-enhancing is
  // the whole recovery path — it replaces the suspect twin from unchanged inputs.
  //
  // ⚠️ `s.enhanced` STILL HIDES THE ACTION ON AN ENHANCED ROW. A verb is
  // offered only where it can do something. On a twin the server's answer is "already full
  // quality" essentially every time, so the button is a 409 with a delay in front of it, which is
  // exactly the shape 6.3's comment below warns about. The QUESTION it was there to ask is
  // already answered passively, with no click and no GPU, by the size ratio in the Length cell's
  // tooltip (`scLenTip`) — which is the better answer anyway, because it is on screen.
  //
  // 📌 THE SERVER STAYS PERMISSIVE, and that is not an inconsistency. It refuses on a
  // MEASUREMENT (`enhance.is_band_limited`) and no longer on either flag, so a genuinely
  // band-limited take that is merely LABELED enhanced can still be fixed. This line is the UI
  // declining to offer the common no-op, not the product forbidding the rare real case.
  if (s.enhanced) return '';
  // 🔴 A box that cannot enhance must not be OFFERED it. Cards can be unticked in
  // ⚙ Settings ▸ Devices, so the enhancer may have no eligible device and the route would answer
  // enhancer needs one of them, so the route would answer 400 for a reason nothing on screen
  // explains. That is the shape of all four 6.0 defects: the UI promising what the server does
  // not keep. `enh` is the same state the Playground and Book Enhance controls gate on
  // (/enhance/info), so there is one answer to this question in the page, not two.
  if (!enh.ok) return `<span class="small muted" title="${esc(enh.msg || '')}" style="margin-left:6px">✨ —</span>`;
  // 🔴 THE MIDDLE SENTENCE SAID “ANOTHER ONE BESIDE IT — NOTHING IS OVERWRITTEN”, AND THAT WAS
  // FALSE. A twin's identity folds the RAW scene's `created` and nonce (scene_hash), not a fresh
  // one, so a re-enhance AT THE SAME STEPS computes the same H8 and `encode_mp3` — which is
  // atomic — REPLACES the twin in place. That is the app's own rule (same inputs, same path, the
  // Playground works this way too) and it is what you want here: the suspect twin is replaced by
  // a good one with no orphan to find and delete. But the tooltip has to say so, because
  // "nothing is overwritten" is the kind of promise someone relies on.
  // ⚠️ Changing the steps changes the hash, so THAT lands beside it rather than on it.
  // 🔴 THE LABEL ANSWERS "DO I NEED TO?", THE BUTTON STILL DOES THE THING. The status label
  // communicates that a twin exists while keeping re-enhancement available for recovery.
  //
  // ⚠️ AND IT MUST STAY CLICKABLE. Removing
  // it here is exactly the 7.5.1 bug recorded above — a restart interrupted a 21-minute
  // enhancement, the twin existed, and the one control that could re-run it was hidden based on
  // the record whose accuracy was in doubt.
  //
  // ✅ The label carries the status while the action remains available for recovery. The tooltip
  // explains the effect of a second press; the row label reports the current state.
  // 8.2.4 — already in the queue: show the WAIT, with the way out of it. Offering "Enhance"
  // again here would be the same confusion the label fix above is about, one step earlier.
  if (scEnhQueued(s.ref))
    return `<span class="small muted" style="margin-left:6px">⏳ queued</span>
    <button class="sm" data-act="enhdequeue" data-ref="${esc(s.ref)}" title="Take this one out of the enhancement queue. Nothing has been spent on it yet.">✕</button>`;
  const twin = scHasTwin(s.ref);
  const again = twin
    ? 'This scene already has an enhanced twin. Enhancing again at the same steps REPLACES it — this raw scene is untouched — which is what you want if you think the first one was cut short. A different number of steps makes a separate twin instead.'
    : 'Make an enhanced copy at 256 kbps, alongside this one. The original is kept — enhancement is a second product, not a replacement.';
  return `<button class="sm${twin ? ' scEnhDone' : ''}" data-act="enhance" data-ref="${esc(s.ref)}" title="${esc(again)}">${twin ? '✨ Already enhanced' : '✨ Enhance'}</button>`;
}

// ── 7.5.1 — the size, on the row, beside the length ──────────────────────────────────────
//
// 🔴 HE COULD NOT, AND THE LENGTH COLUMN WAS THE REASON. A twin's manifest is `dict(manifest)` of
// its parent's, so `total_duration_s` was INHERITED — the row printed the raw scene's length for
// the twin no matter what the twin held. 7.5.1 makes `scene_enhance` measure it instead, which
// fixes every enhancement from now on; the SIZE fixes the ones already on disk, because it has
// always been the one field on this row measured from the file (`vault_fs.stat`, the logical
// size — see `list_scenes`, which is careful not to report the ciphertext size here).
//
// 📌 Bitrate is the whole trick and it is why the number is worth a column-width: a raw scene is
// 96 kbps and a twin is 256, so a COMPLETE twin is almost exactly **2.67×** its parent. A shorter
// partial twin would be smaller than its raw scene, making an interrupted enhancement visible.
const SC_ENH_RATIO = 256 / 96; // enhance.mp3_bitrate(True) over mp3_bitrate(False)
/** @param {SceneRow} s */
function scLenTip(s) {
  const bits = [];
  if (s.size) bits.push(`${fmtSize(s.size)} on disk`);
  // The comparison only means something between a twin and the parent it names.
  const parent = s.raw_ref ? scLib.items.find(x => x.kind === 'scene' && x.ref === s.raw_ref) : null;
  if (parent && parent.size && s.size) {
    const r = s.size / parent.size;
    bits.push(
      r >= SC_ENH_RATIO * 0.9
        ? `${r.toFixed(2)}× its raw take — a complete enhancement is about ${SC_ENH_RATIO.toFixed(2)}×, so this one ran the whole way through`
        : // ⚠️ "THE ✨ BUTTON", NOT "✨ ENHANCE". This sentence fires exactly when a twin EXISTS and
          // looks short — which is precisely the case where scEnhCell now labels that button
          // "✨ Already enhanced". Naming the old label here would send him looking for a control that
          // is on screen under a different word, which is worse than saying nothing.
          `⚠ only ${r.toFixed(2)}× its raw take, and a complete enhancement is about ${SC_ENH_RATIO.toFixed(2)}× — this twin looks CUT SHORT. Press the ✨ button on the raw scene to make another one.`,
    );
  }
  if (s.kind === 'scene' && !s.enhanced && !s.raw_ref) bits.push('Raw take, 96 kbps.');
  return bits.join(' · ');
}

// Shared source preparation copies scene and Playground clips into the Speech library.
/** @type {Partial<Record<SceneKind, string>>} */
const SC_SPEECH_URL = { scene: '/train/import_scene', playground: '/train/import' };
/** @param {SceneRow} s */
function scSpeechCell(s) {
  if (!SC_SPEECH_URL[s.kind]) return '';
  return `<button class="sm" data-act="speech" data-ref="${esc(s.ref)}" data-kind="${esc(s.kind)}" title="Add this ${s.kind === 'scene' ? 'scene' : 'clip'} to Speech sources">＋ Speech</button>`;
}

/**
 * @param {string} kind
 * @param {string} ref
 * @param {HTMLButtonElement|null} [btn] - the pressed button, spun while the request is in flight
 */
async function scAddSpeech(kind, ref, btn) {
  const row = scLib.items.find(x => x.kind === kind && x.ref === ref);
  if (!row) return;
  // A 409 means Speech already has a clip under this name; let the user choose whether to replace it.
  /** @param {boolean} ow */
  const send = async ow => {
    // `kind` comes from the row button, which is rendered only for keys in `SC_SPEECH_URL`.
    // `SceneKind` says it
    // could in principle be 'upload' too, which this route never sees.
    try {
      return await jpost(
        /** @type {string} */ (SC_SPEECH_URL[/** @type {SceneKind} */ (kind)]),
        kind === 'scene' ? { ref, overwrite: ow } : { clip: ref, overwrite: ow },
      );
    } catch (err) {
      if (/** @type {ErrLike} */ (err).status === 409 && !ow) {
        const ok = await modal(
          'Already in the speech clips',
          `<b>${esc(/** @type {string | undefined} */ (/** @type {ErrLike} */ (err).body && /** @type {ErrLike} */ (err).body.name) || 'this clip')}</b> is already a speech clip. Replace it with this version?`,
          [
            { label: 'Cancel', value: 0 },
            { label: 'Replace', class: 'danger', value: 1 },
          ],
        );
        if (ok) return send(true);
        return null;
      }
      await modal('Send failed', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
      return null;
    }
  };
  // SPINS, and the reason is worth more here than it was in the Playground: `import_clip` streams
  // the whole file through scratch and re-encrypts it into the pool, and a scene is up to an hour
  // of audio. A spinner communicates that this potentially long copy is still in progress.
  let out;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" style="margin:0"></span>';
  }
  try {
    out = await send(false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '＋ Speech';
    }
  } // restore even on error/cancel
  if (!out) return;
  switchTab('voicestudio');
  switchStudioPanel('speech');
  await spLoadAll();
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// 8.2.4 — THE ENHANCEMENT QUEUE
//
// ── 9.2.1: what a running enhancement looks like WHILE it runs ──────────────────────────────────
//
// `scEnhPoll` read the status every 1.5 s and threw away
// everything except the three terminal words, so the row said "Enhancing…" for the whole of an
// eight-minute job — and a twenty-one-minute one that a restart had killed looked identical.
//
// 🔴 THE BAR IS ELAPSED OVER `est_s`, AND `est_s` CAN BE NULL. `enhance.estimate_seconds` is
// explicit that "NONE IS A REAL ANSWER AND CALLERS MUST RENDER IT" — a box that has never been
// timed has no rate to estimate from. So the fill runs INDETERMINATE (`.indet`, the sweep the
// training banner already uses for its pre-epoch stages) rather than inventing a percentage. Same
// rule as the ST extension's scene bar, and `enhance_rate.py`'s from the beginning.
//
// ⚠️ CAPPED AT 99%, NEVER 100. The estimate is a measured average and a slow run overruns it; a
// bar sitting at 100% while the job runs on is a worse lie than one sitting at 99% next to the
// words "taking longer than the estimate". Only a terminal status empties the row.
/**
 * @param {string} ref
 * @param {SceneEnhJob} live
 */
function scEnhLive(ref, live) {
  const pct = live.pct;
  return `<span class="bar" id="enhb-${esc(ref)}" style="display:inline-block;width:90px;height:8px;margin:0 6px;vertical-align:middle" title="${esc(
    SC_ENH_BAR_TITLE,
  )}"><div class="vvoc${pct == null ? ' indet' : ''}"${pct == null ? '' : ` style="width:${pct}%"`}></div></span>
    <span class="small muted" id="enht-${esc(ref)}">${esc(live.text)}</span>
    <button class="sm danger" data-act="enhcancel" data-ref="${esc(
      ref,
    )}" title="Stop enhancing. The scene itself is untouched — it is complete either way.">■</button>`;
}

//: Hovering the bar is where the enhancer's own last line goes — including "Waiting for cuda:1 (a
//: training is using it)", which is the one thing that makes a bar that is not moving make sense.
//: ⚠️ A TOOLTIP rather than the row's sentence, deliberately: the child's output is our
//: subprocess's stdout and not a designed message, so a stray traceback line or a resampler note
//: would otherwise land in the middle of the table.
const SC_ENH_BAR_TITLE = "Elapsed against this box's own measured rate for an enhancement of this length.";

/** Update the two elements affected by one enhancement poll without rebuilding the table. A full render would discard active rename edits, expanded chapters, and the audio row. Store the new status in `scLib.enh` so a later render restores the current progress.
 * @param {string} ref
 * @param {any} s - the status payload
 */
function scEnhTick(ref, s) {
  const live = scLib.enh[ref];
  if (!live) return;
  const est = typeof s.est_s === 'number' && s.est_s > 0 ? s.est_s : null;
  const el = typeof s.elapsed_s === 'number' ? s.elapsed_s : null;
  live.pct = est !== null && el !== null ? Math.max(0, Math.min(99, Math.round((el / est) * 100))) : null;
  live.text = scEnhSentence(s, est, el);
  const bar = $(`enhb-${ref}`);
  const fill = bar && /** @type {HTMLElement|null} */ (bar.firstElementChild);
  if (fill) {
    fill.classList.toggle('indet', live.pct == null);
    fill.style.width = live.pct == null ? '' : `${live.pct}%`;
  }
  if (bar && s.line) bar.title = `${SC_ENH_BAR_TITLE} Last line: ${s.line}`;
  const label = $(`enht-${ref}`);
  if (label) label.textContent = live.text;
}

/**
 * What the row SAYS, which is a different question from how full the bar is.
 *
 * The phases are the steps of `scene_enhance.run_enhance` and nothing else — never a guess about
 * what the child is doing. They exist because model loading can take about two minutes with no
 * model load with nothing to show for it, and a bar at zero for two minutes reads as stuck where
 * a bar at zero beside "Decoding the scene…" reads as what it is.
 * @param {any} s
 * @param {number|null} est
 * @param {number|null} el
 */
function scEnhSentence(s, est, el) {
  if (s.phase === 'decoding') return 'Decoding the scene…';
  if (s.phase === 'encoding') return 'Encoding the twin at 256 kbps…';
  if (el === null) return 'Starting…';
  const spent = fmtEta(el);
  if (est === null) return `Enhancing — ${spent} so far · this box has never been timed, so there is no estimate`;
  if (el > est) return `Enhancing — ${spent} of ~${fmtEta(est)}, taking longer than the estimate`;
  return `Enhancing — ${spent} of ~${fmtEta(est)}`;
}

// 🔴 WHY IT EXISTS. An enhancement occupies a card for minutes, so a batch of scenes should queue
// without requiring a new manual start after each one. An enhancement is minutes of one whole card, so a dozen scenes
// is an evening of returning to the tab to press the next button.
//
// ✅ 11.2.7 — IT IS A SERVER-SIDE QUEUE NOW. Until this release the paragraph here read "IT IS A
// CLIENT-SIDE QUEUE, AND THAT IS A REAL LIMITATION": the pump lived in this tab, so the queue only
// advanced while the tab was open, and the strip said "⚠️ this queue runs in this tab — leave it
// open". The waiting list, the pump, the 30 s retry and the
// done/failed bookkeeping all moved to `scene_enhance_queue.py`, which calls the ✨ route's own
// start function (`web/clips.py::_start_enhance`) — so the card claim described below is still the
// one and only claim. This tab now MIRRORS that queue (`scEnhSync`) and sends changes to it.
//
// The paragraphs below describe rules the pump followed. They moved with it and still hold, now
// in the server module; they are kept here because the strip's wording still follows them.
//
// ⚠️ NO MODALS FROM THE PUMP. `scEnhance` shows one on failure, which is right for a button press
// and catastrophic for a queue: twelve refusals overnight would be twelve stacked dialogs, and the
// first one blocks the pump so the other eleven never run. Queue-driven failures go into
// `scLib.enhFail` and are reported once, on the strip, where they can be read in the morning.
//
// ⚠️ CARD-BUSY IS NOT A FAILURE, IT IS A WAIT. The 409 carries `busy` (render / render_waiting /
// cards) precisely so this can tell "come back in a minute" from "this will never work". The item
// STAYS at the head of the queue and retries while an eligible card is busy rendering.
//
// 🔴 9.0.13 — ONE IN FLIGHT PER CARD, NOT ONE IN FLIGHT FULL STOP. The pump must fill each eligible
// card instead of serializing all queued enhancements behind one card.
//
// **Nothing on the server had to change, and that is the evidence this was a client-side mistake
// rather than a policy.** Every layer below already does one enhancement per card and says so:
// `clips_scene_enhance` claims ONE card per request from `GPUS.claim_card`, so two requests take
// two different cards; `scene_enhance.running_for` is deliberately per-SCENE and not per-box
// ("two scenes enhancing on two cards is two child processes on two cards"); and the book's own
// post-pass (`books.py::_enhance_book`) has always fanned chapters across every card. The one
// thing that must not happen — the same scene twice — is refused atomically under `JOBS_LOCK` in
// `scene_enhance.start`, not by this pump being single-file.
//
// ⚠️ THE LIMIT IS `enh.cards`, READ AT PUMP TIME. That is `/enhance/info`'s count of eligible
// cards (⚙ Settings ▸ Devices ∩ CUDA), and `loadEnhanceInfo` rewrites it when a card is ticked —
// so reading it per pump rather than latching it at load means un-ticking a card mid-queue
// narrows the fan-out on the next start instead of being ignored until a reload.
//
// ⚠️ AND OVER-OFFERING IS SAFE, WHICH IS WHY THE LIMIT NEED NOT BE EXACT. A start that finds no
// free card comes back 409 `busy` — a WAIT, not a failure (above) — so the worst case of asking
// for two while a render holds one is one extra refusal and a 30 s retry, the same path the queue
// already walks every night. Under-offering is the expensive direction: it is an idle card.

//: 11.2.7 — how often the tab re-reads the server's queue WHILE there is something in it (waiting,
//: starting or running). Nothing is decided here any more, so this is only how fresh the strip
//: is; the per-job progress poll (`scEnhPoll`) keeps its own 1.5 s.
const SC_ENH_SYNC_MS = 2000;
let scEnhRestored = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let scEnhSyncTimer = null;
//: The last snapshot the strip was painted from — a sync that changes nothing must not repaint the
//: table (the rule `scEnhTick` spells out: a poll never re-renders an inline editor away).
let scEnhSig = '';

/** @param {string} ref */
const scEnhQueued = ref => scLib.enhQ.includes(ref);
//: How many at once — one per eligible card, as the SERVER counts them; the page's own count until
//: the first sync answers, and never fewer than one.
const scEnhLimit = () => Math.max(1, scLib.enhLimit || enh.cards || 1);

/**
 * One running job as `GET /clips/scenes/enhance` lists it — only the two fields adoption reads.
 * @typedef {object} SceneEnhJobRow
 * @property {string} [src_ref]
 * @property {string} [job_id]
 */
/**
 * The server's queue, as `GET /clips/scenes/enhance` and every queue POST return it.
 * @typedef {object} SceneEnhQueueState
 * @property {string[]} [queue]
 * @property {string[]} [starting]
 * @property {Record<string, string>} [failed]
 * @property {string} [wait]
 * @property {number} [done]
 * @property {number} [limit]
 */
/** @param {SceneEnhQueueState|null|undefined} q */
function scEnhApply(q) {
  if (!q) return;
  scLib.enhQ = Array.isArray(q.queue) ? q.queue : [];
  scLib.enhStarting = Array.isArray(q.starting) ? q.starting : [];
  scLib.enhFail = q.failed || {};
  scLib.enhWait = q.wait || '';
  scLib.enhDone = q.done || 0;
  scLib.enhLimit = q.limit || 0;
}

/** Repaint only when the queue's state actually moved. */
function scEnhRepaintIfChanged() {
  const sig = JSON.stringify([
    scLib.enhQ,
    scLib.enhStarting,
    scLib.enhFail,
    scLib.enhWait,
    scLib.enhDone,
    scLib.enhLimit,
    Object.keys(scLib.enh),
  ]);
  if (sig === scEnhSig) return;
  scEnhSig = sig;
  renderScenes();
}

const scEnhHasWork = () => scLib.enhQ.length > 0 || scLib.enhStarting.length > 0 || Object.keys(scLib.enh).length > 0;

/**
 * Read the server's queue and adopt every enhancement it is running. Re-arms itself while there is
 * work, and stops when there is none — a later `scEnhQueue` or `loadScenes` starts it again.
 *
 * 🔴 ADOPTING IS NO LONGER A ONE-TIME RECOVERY. 9.2.2 adopted running jobs once, on the first load,
 * because only a reload could produce a job this tab had not started. Now the SERVER starts every
 * queued job, so each one arrives here as a job this tab has never seen, and adoption is simply how
 * the tab learns that a queued scene began: its row gets a bar and a ■, and `scEnhPoll` finishes it.
 * ⚠️ Only rows that are in `items` are adopted — a job whose scene is not listed has nothing to
 * paint on, and a poll kept alive for it would run for a row that does not exist.
 */
async function scEnhSync() {
  if (scEnhSyncTimer) {
    clearTimeout(scEnhSyncTimer);
    scEnhSyncTimer = null;
  }
  /** @type {{jobs?: SceneEnhJobRow[], queue?: SceneEnhQueueState}|null} */
  let live = null;
  try {
    live = await jget('/clips/scenes/enhance');
  } catch (e) {
    live = null; // an older server, or a box that is not answering — try again on the next tick
  }
  if (live) {
    scEnhApply(live.queue);
    const rows = new Set(scLib.items.filter(x => x.kind === 'scene').map(x => x.ref));
    for (const j of live.jobs || []) {
      if (!j.src_ref || !j.job_id || scLib.enh[j.src_ref] || !rows.has(j.src_ref)) continue;
      scLib.enh[j.src_ref] = { job: j.job_id, text: 'Enhancing…', pct: null };
      scEnhPoll(j.src_ref, j.job_id);
    }
  }
  scEnhRepaintIfChanged();
  if (!live || scEnhHasWork()) scEnhSyncTimer = setTimeout(scEnhSync, SC_ENH_SYNC_MS);
}

/**
 * Send one change to the server's queue and mirror what comes back.
 * @param {object} body - one of {add}, {remove}, {clear}, {move, before}, {stop}
 */
async function scEnhSend(body) {
  try {
    scEnhApply(await jpost('/clips/scenes/enhance/queue', body));
  } catch (err) {
    const b = /** @type {HttpErrorBody} */ ((err && /** @type {ErrLike} */ (err).body) || {});
    const msg = (typeof b.error === 'string' && b.error) || (err && /** @type {ErrLike} */ (err).message) || 'the server refused';
    await modal('Enhancement queue', esc(msg), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
  // 🔴 ALWAYS REPAINT AFTER A CHANGE HE MADE. Every caller has already painted its optimistic guess
  // without touching the signature, so if the server's answer happens to equal the state from
  // BEFORE the guess (an add it skipped, a move it treated as a no-op) the signature would match,
  // nothing would repaint, and the guessed row would stay on screen. Clearing it forces the
  // server's answer onto the page; only the idle POLL is meant to skip unchanged repaints.
  scEnhSig = '';
  scEnhRepaintIfChanged();
  scEnhSync();
}

//: 🔴 ONE-TIME MIGRATION, 11.2.7. Before this release the queue lived in ui-state under
//: `vocalis-sc-enhq` (8.2.4; the key was fixed at 9.5.6 — see git history for that story). A
//: browser that still holds a list hands it to the server once and clears the key, so an evening's
//: queue that was waiting in a tab when this deployed is not silently dropped.
//: ⚠️ Refs are validated against the loaded rows first, for the reason the old restore gave: a
//: queued scene can be deleted from another tab, and the server would refuse the whole batch.
export function scEnhRestore() {
  let saved = [];
  try {
    saved = JSON.parse(UIS.getItem('vocalis-sc-enhq') || '[]');
  } catch (e) {
    saved = [];
  }
  if (!Array.isArray(saved) || !saved.length) return;
  try {
    UIS.setItem('vocalis-sc-enhq', '[]');
  } catch (e) {}
  const live = new Set(scLib.items.filter(x => x.kind === 'scene' && !x.enhanced).map(x => x.ref));
  const refs = saved.filter(r => live.has(r));
  if (refs.length) scEnhSend({ add: refs });
}

/** @param {string} ref */
function scEnhQueue(ref) {
  scEnhQueueMany([ref]);
}

/**
 * Add scenes to the server's queue, in the order given. Optimistic: the rows show as waiting at
 * once, and the server's answer replaces the guess a moment later.
 * @param {string[]} refs
 */
function scEnhQueueMany(refs) {
  const add = refs.filter(r => !scEnhQueued(r) && !scLib.enh[r]);
  if (!add.length) return;
  add.forEach(r => {
    delete scLib.enhFail[r];
    scLib.enhQ.push(r);
  });
  renderScenes();
  scEnhSend({ add });
}

/** @param {string} ref */
function scEnhDrop(ref) {
  const i = scLib.enhQ.indexOf(ref);
  if (i < 0) return;
  scLib.enhQ.splice(i, 1);
  if (!scLib.enhQ.length) scLib.enhWait = '';
  renderScenes();
  scEnhSend({ remove: ref });
}

function scEnhClear() {
  scLib.enhQ = [];
  scLib.enhWait = '';
  renderScenes();
  scEnhSend({ clear: true });
}

// ── 9.5.6: reorder the queue by dragging ──────────────────────────────────────────────────────
//
// An enhancement occupies a card for minutes, so a long queue benefits from drag-and-drop order;
// the thing
// you want at 11pm is not "take six out and put them back in a different order", it is "that one
// first". Removing and re-queueing already worked and is the same verb spelled out in six presses.
//
// 🔴 STATED AS "BEFORE WHICH REF", NOT AS AN INDEX, and that is the whole reason this is a
// function rather than three lines in the drop handler. An index computed against the list you can
// see is wrong the moment the moved item is spliced out of it: dragging row 2 to row 5 means index
// 5 while it is still there and index 4 once it is gone, and getting that wrong by one is a bug
// that only shows up in one direction of travel. A ref is stable across the removal — `null` is
// "the end", which is the one position no ref can name.
//
// ⚠️ IT DOES NOT PUMP. Reordering changes nothing about capacity: whatever was startable before is
// startable now, and the pump has already been called by whatever made it so. A pump here would
// additionally re-offer a scene to a box that just refused it, ahead of its 30 s retry.
// 📌 11.2.7: the move is applied here first so the row lands where it was dropped, then sent to the
// server (`{move, before}` — the same "before which ref" statement), whose answer is the truth.
/**
 * Move `ref` so it sits immediately before `beforeRef` — or at the end when that is null.
 * @param {string} ref
 * @param {string|null} beforeRef
 * @returns {boolean} whether the queue actually changed
 */
function scEnhMove(ref, beforeRef) {
  // 🔴 DROPPED ON ITSELF. Without this the row is spliced out and then re-inserted at the position
  // of a ref that is no longer in the list — `indexOf` answers -1, which is the same answer an
  // unknown destination gives, so a row released on its own grip jumped to the END of the queue.
  // Found by the smoke, not by reading: the two -1s are indistinguishable at the splice.
  if (ref === beforeRef) return false;
  if (scLib.enhQ.indexOf(ref) < 0) return false;
  const rest = scLib.enhQ.filter(r => r !== ref);
  const at = beforeRef == null ? -1 : rest.indexOf(beforeRef);
  rest.splice(at < 0 ? rest.length : at, 0, ref);
  // Dropped where it already was. Returning early rather than saving and repainting keeps a
  // no-op gesture genuinely free — and, more usefully, lets the drop handler tell the caller
  // whether anything happened without comparing the arrays itself.
  if (rest.every((r, i) => r === scLib.enhQ[i])) return false;
  scLib.enhQ = rest;
  renderScenes();
  // 🔴 the order is part of the queue, so the server keeps it — it survives a reload, a closed tab
  // and a restart like the queue does
  scEnhSend({ move: ref, before: beforeRef });
  return true;
}

// 🔴 NEVER REPAINT UNDER A LIVE DRAG — the guard `ui/folders.js` exists for, applied to a renderer
// that is not on a timer. `renderScenes` replaces the whole of `#scList` with `innerHTML`, so a
// render landing mid-gesture destroys the element under the cursor: the drag dies with no drop
// event, no error and nothing on screen to explain it, which reads as a flaky browser rather than
// as a bug. An enhancement finishing is exactly such a render, and it is minutes-rare — i.e. rare
// enough to be a mystery when it happens and never to be reproduced on purpose.
//
// ⚠️ AND THE DEFERRED RENDER MUST ACTUALLY RUN, WHICH IS WHERE THIS DIFFERS FROM THE POLL-DRIVEN
// LISTS. `ace/tray.js` and the stems library just `return` — another tick is 2 s away and will
// paint whatever was missed. Nothing follows this one, so a dropped render would leave the table
// showing a scene that finished thirty seconds ago until the next unrelated event. Hence the
// pending flag: `scEnhDragEnd` flushes it, and `dragend` fires even when the drag is abandoned
// with Escape or dropped outside the window.
let scEnhDragRef = '';
let scEnhRenderPend = false;
/** @param {string} ref */
function scEnhDragBegin(ref) {
  scEnhDragRef = ref;
}
function scEnhDragEnd() {
  if (!scEnhDragRef) return;
  scEnhDragRef = '';
  if (!scEnhRenderPend) return;
  scEnhRenderPend = false;
  renderScenes();
}

// 9.2.1 — ONE control that means "stop". `Clear` empties the
// queue and each running row's ■ cancels that one — and "I don't remember" is exactly what a
// feature split across two places and named after neither of them feels like.
//
// ⚠️ CONFIRMED ONLY WHEN SOMETHING IS RUNNING, because that is the only case that throws work
// away: a queued item has had nothing spent on it, so asking about those would be a dialog in
// front of an action with no cost. The scenes are never at risk either way — an enhancement is a
// SECOND product and the raw take is complete before it starts.
//
// 🔴 THE QUEUE IS EMPTIED FIRST, THEN THE RUNNING SET IS CANCELED. Emptying it before the cancels
// stops the pump refilling the card a cancel has just freed. 11.2.7: both halves are ONE server
// call now (`{stop:true}` → `EnhanceQueue.stop_all`), which cancels every running scene
// enhancement on the box — including one this tab had not adopted yet.
async function scEnhStopAll() {
  const n = Object.keys(scLib.enh).length;
  if (
    n &&
    !(await modal(
      'Stop every enhancement?',
      `${n} enhancement${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} running, and stopping ${
        n === 1 ? 'it' : 'them'
      } throws away the time already spent. <b>The scenes themselves are untouched</b> — an enhanced copy is a second product, and the raw take is complete either way.`,
      [
        { label: 'Leave them running', value: 0 },
        { label: 'Stop everything', class: 'danger', value: 1 },
      ],
    ))
  )
    return;
  scLib.enhQ = [];
  scLib.enhWait = '';
  for (const live of Object.values(scLib.enh)) {
    live.text = 'Canceling…';
    live.pct = null;
  }
  renderScenes();
  await scEnhSend({ stop: true });
}

// 11.2.7 — `scEnhPump` WAS HERE, and the loop that started the next scene when a card freed. It
// moved to the server (`scene_enhance_queue.EnhanceQueue.pump`) with its rules: fill every free
// card from the head, a busy card is a WAIT retried every 30 s, a refusal is terminal and goes to
// the strip.

// The strip above the table: what is waiting, what is running, why, and how to stop it.
//
// 🔴 9.2.2 — REAL BUTTONS, NOT `xs` LINKS BURIED IN A MUTED SENTENCE. `Clear` had
// been there since 8.2.4 — as an `xs` button inside a `small muted` line, which is the visual
// weight of a footnote, so the only control he could SEE was the ✕ on each pill. A control that
// exists and cannot be found has not shipped.
//
// 🔴 9.5.6 — AND THE OTHER HALF OF THAT SENTENCE FINALLY LANDED. 9.2.2 gave the strip proper
// buttons and left the items as pills. A vertical list aligns each job, exposes its position, and
// supports reordering.
//
// ⚠️ THE "ELSEWHERE IN THE APP" IS THE MUSIC TRAY, AND IT ALWAYS WAS. `ace/tray.js`'s
// `candidateRow` is one `.acerow` per job — name that ellipsizes, meta, and the verb in its own
// column at the right — and that is the shape copied here. A pill wraps at the container edge, so
// fourteen of them are a ragged block in which no two rows start at the same x and the ✕ lands
// somewhere different on every line; there is also nowhere to put a position number, which is the
// one fact a queue is FOR. Rows fix all of that by construction.
//
// 🔴 THE HEADER IS NO LONGER A `.row`, AND THAT IS THE FIX FOR THE SQUISH RATHER THAN A TIDY-UP.
// Every cell carried `style="flex:0"`, which against `.row>div{flex:1 1 150px}` resolves to
// `flex:0 1 0%` — basis ZERO with shrink still on — so each cell was sized by its longest word and
// "⚠️ this queue runs in this tab — leave it open" rendered as eight stacked lines. `lora.css`
// records the identical defect on three LoRA readouts. With no `.row` ancestor there is nothing
// to override and no inline `flex` to get wrong; `meters.css` owns the sizing now.
/** The strip above the table: what is waiting, why, and how to take something out of it. */
function scEnhStrip() {
  const fails = Object.entries(scLib.enhFail);
  // 9.2.1 — a running enhancement with an empty queue used to render no strip at all, so "how far
  // through the batch am I" had nowhere to live from the moment the last item was handed out.
  const running = Object.keys(scLib.enh).length;
  if (!scLib.enhQ.length && !fails.length && !running) return '';
  /** @param {string} r */
  const byRef = r => {
    const it = scLib.items.find(x => x.ref === r);
    return it ? it.name : r;
  };
  // ⚠️ EVERY ROW HERE IS WAITING — a running scene left the queue when its start resolved, so
  // queue[0] is the NEXT one and wore a "playing" ▶ it had not earned.
  // 🔴 THE MARK FOLLOWS `enhStarting` (the server's list since 11.2.7), NOT THE INDEX. With one start per card there can be two
  // (or more) refs mid-POST, and pinning ⏳ to index 0 would have shown one row trying while an
  // identically-placed sibling looked idle.
  // 🔴 AND 9.5.6 SPLITS THE TWO STATES THE ⏳ USED TO BLUR, BECAUSE DRAGGING MADE THE DIFFERENCE
  // MATTER. "Its POST is in flight" and "it is merely first in line" wore the same mark; the first
  // has left this list's control — the server's pump is already starting it, so moving it changes
  // nothing — and the second is exactly the row you would want to move. A gesture that is accepted
  // and then does nothing is worse than one that is refused, so a starting row is `draggable=false`
  // and says why.
  const rows = scLib.enhQ
    .map((r, i) => {
      const starting = scLib.enhStarting.includes(r);
      const next = !starting && i === 0 && !scLib.enhStarting.length;
      const name = esc(byRef(r));
      return `<div class="scEnhItem" data-ref="${esc(r)}" draggable="${starting ? 'false' : 'true'}" title="${
        starting ? 'Starting now — it has left the queue and cannot be re-ordered.' : 'Drag to move this one up or down the queue.'
      }">
      <span class="scEnhGrip" aria-hidden="true">⠿</span>
      <span class="scEnhPos">${i + 1}</span>
      <span class="scEnhName" title="${name}">${name}</span>
      <span class="scEnhState">${starting ? '⏳ starting…' : next ? 'next' : ''}</span>
      <button class="xs scEnhX" data-act="enhdequeue" data-ref="${esc(r)}" title="Take this one out of the queue">✕</button></div>`;
    })
    .join('');
  const failRows = fails.map(([r, m]) => `<div class="small" style="color:var(--warn)">✕ ${esc(byRef(r))} — ${esc(m)}</div>`).join('');
  return `<div class="scEnhQ" style="margin:0 0 8px">
    ${
      scLib.enhQ.length || running
        ? `<div class="scEnhHead">
        <b class="small">Enhancement queue</b>
        <span class="small muted scEnhCounts">${[
          running ? `${running} running` : '',
          scLib.enhQ.length ? `${scLib.enhQ.length} waiting` : '',
          scLib.enhDone ? `${scLib.enhDone} done` : '',
        ]
          .filter(Boolean)
          .join(' · ')}${scEnhLimit() > 1 ? ` · ${scEnhLimit()} at a time, one per card` : ''}</span>
        ${
          scLib.enhQ.length
            ? `<button class="sm" data-act="enhclear" title="Take every waiting scene out of the queue. Anything already running is left alone — use Stop everything for that. Nothing has been spent on a waiting scene, so this costs nothing.">🗑 Clear queue (${scLib.enhQ.length})</button>`
            : ''
        }
        <button class="sm danger" data-act="enhstopall" title="Empty the queue AND cancel what is already running. Every scene is untouched — an enhanced copy is a second product, so canceling one costs the time it had spent and nothing else.">■ Stop everything</button></div>${
          rows ? `<div class="scEnhList" id="scEnhList">${rows}</div>` : ''
        }${
          scLib.enhQ.length > 1
            ? '<div class="small muted" style="margin-top:4px">Drag a row to change the order · ✕ takes one out</div>'
            : ''
        }`
        : ''
    }
    ${scLib.enhWait ? `<div class="small muted" style="margin-top:4px">⏳ ${esc(scLib.enhWait)}</div>` : ''}
    ${failRows}</div>`;
}

// 11.2.7 — `scEnhance`, the tab's start POST, WAS HERE. The server's queue starts every scene now,
// through the same function the ✨ route uses, so its transient/terminal split ("a busy card is a
// wait, 'already full quality' is not") lives in `scene_enhance_queue.classify`. A single press
// that is refused shows its reason on the strip — there is no longer a tab-side request to raise a
// dialog from.

//: 🔴 ONE POLL PER REF, AND 9.2.2 IS WHAT MADE IT REACHABLE. Two paths can now arrive at the same
//: running job on the same load: `scEnhAdopt` takes over everything the box says is active, and the
//: pump's own start POST answers 409 `enhancing` for a ref the restored queue still lists — that
//: 409 path has ALWAYS reattached, and until adopt existed it was the only way in.
//:
//: ⚠️ TWO INTERVALS ON ONE JOB IS NOT MERELY WASTEFUL. Both see the terminal status, so both run
//: the finish path: `scLib.enhDone` is incremented twice and the strip reports four done out of
//: three. A counter that over-reports is the same class of defect as a bar that lies.
//: 📌 11.2.7: `scEnhSync` is the adopter now (every sync, not once) and the server counts `done`,
//: so a double poll would no longer double the counter — but it would still run the finish path
//: twice, reloading the list and raising the failure dialog twice. The guard stays.
/** @type {Map<string, string>} ref → the job id currently being polled for it */
const scEnhPolls = new Map();

/**
 * @param {string} ref
 * @param {string} jobId
 */
function scEnhPoll(ref, jobId) {
  if (scEnhPolls.get(ref) === jobId) return; // already watched — see the note above
  scEnhPolls.set(ref, jobId);
  // ðŸ”´ A poll that swallows its errors never ends. `scene_enhance.JOBS` is in-process only, so a
  // deploy or restart during an ~8-minute enhancement makes this 404 for ever -- and the old
  // `catch(e){return;}` meant clearInterval was never reached and `scLib.enh[ref]` never cleared.
  // The row read "Enhancingâ€¦" until the page was reloaded, its â–  posted to a 404, and the tab
  // polled a dead job every 1.5s for the life of the page. An 8-minute window is exactly where a
  // restart lands, so give up and say so, as the extension's own build poll does.
  let misses = 0;
  const tick = setInterval(async () => {
    let s;
    try {
      s = await jget(`/clips/scenes/enhance/${encodeURIComponent(jobId)}`);
      misses = 0;
    } catch (e) {
      if (e && /** @type {ErrLike} */ (e).status === 404)
        misses = 99; // the job is gone, not merely unreachable
      else misses++;
      if (misses < 5) return;
      clearInterval(tick);
      scEnhPolls.delete(ref);
      delete scLib.enh[ref];
      renderScenes();
      await modal(
        'Lost contact with the enhancement',
        'The status of that job can no longer be read â€” the server may have restarted. ' +
          '<b>The scene itself is untouched</b>, and if the enhancement did finish its ' +
          'twin will appear on â†» Refresh.',
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
      return;
    }
    // 9.2.1 — THE TICK THAT IS NOT TERMINAL IS THE ONE THE PROGRESS BAR IS MADE OF. This was a
    // bare `return`, which is why the row said "Enhancing…" for twenty-one minutes.
    if (s.status !== 'done' && s.status !== 'failed' && s.status !== 'canceled') {
      scEnhTick(ref, s);
      return;
    }
    clearInterval(tick);
    scEnhPolls.delete(ref);
    delete scLib.enh[ref];
    await loadScenes(); // the twin is a NEW row, and this row loses its button
    // 🔴 THE NEXT ONE STARTS BEFORE ANYTHING IS ANNOUNCED. `modal` awaits a click, so raising the
    // failure dialog first would hold the pump until someone pressed OK — the queue would stop at
    // the first bad scene and be found in the morning exactly where it stalled.
    // 11.2.7 — the server already started the next one; this refreshes the strip's counts.
    const draining = scLib.enhQ.length > 0;
    scEnhSync();
    if (s.status === 'failed') {
      // ⚠️ While a queue is draining the reason goes to the strip, not to a dialog, for the same
      // reason the start-refusal path above does it: an overnight run must never stack modals.
      // The server's queue records the reason in `failed` too; the next sync carries it.
      if (draining) scLib.enhFail[ref] = s.error || 'something went wrong';
      else
        await modal(
          'Enhancing failed',
          esc(s.error || 'something went wrong') +
            '<div class="small muted" style="margin-top:6px">The scene itself is untouched — it is complete, playable and downloadable exactly as it was.</div>',
          [{ label: 'OK', class: 'primary', value: 1 }],
        );
      renderScenes();
    }
  }, 1500);
}

// The ▲/▼, on the ACTIVE column only — an arrow on every header says nothing about which one
// the list is actually in. Same shape the Playground draws, so the two tables read identically.
/** @param {string} k @returns {string} */
const scArrow = k => (scLib.sort === k ? (scLib.dir > 0 ? ' ▲' : ' ▼') : '');
const SC_SORT_TIP = 'Click to sort (click again to flip)';

function renderScenes() {
  // 🔴 A LIVE DRAG OWNS THE DOM UNTIL IT ENDS — see `scEnhDragBegin` for why, and for why this
  // one has to remember that it skipped rather than shrug the way a poll-driven list does.
  if (scEnhDragRef) {
    scEnhRenderPend = true;
    return;
  }
  const a = scFiltered();
  const tot = scLib.items.reduce((s, c) => s + (c.size || 0), 0);
  /** @type {VEl} */ ($('scTotals')).textContent = scLib.items.length
    ? `— ${scLib.items.length} clip${scLib.items.length === 1 ? '' : 's'} · ${fmtSize(tot)}`
    : '';
  // ⚠️ THE QUEUE BOX SCROLLS AND THIS RENDER REPLACES IT WHOLESALE. Fourteen items is four
  // screens of list; without this, an enhancement finishing while he is looking at item eleven
  // snaps him back to item one. Read before the write, restored after it — the box is a NEW
  // element by then, so the number has to be carried, not the node.
  const qTop = ($('scEnhList') || { scrollTop: 0 }).scrollTop;
  /** @type {VEl} */ ($('scList')).innerHTML = a.length
    ? scEnhStrip() +
      `<div style="overflow-x:auto"><table class="pgtable"><thead><tr>
      <th style="width:24px"><input type="checkbox" id="scSelAll"${a.length && a.every(scHas) ? ' checked' : ''}></th>
      <th style="width:20px" title="Starred clips. Tick “★ favorites only” above to see just these."></th>
      <th style="width:150px" data-sort="who" title="Who speaks in this clip. Built from the scene's own manifest. ${SC_SORT_TIP}">Character${scArrow('who')}</th>
      <th class="scname" data-sort="name" title="${SC_SORT_TIP}">Name${scArrow('name')}</th>
      <th data-sort="kind" title="Which store the clip lives in — a built scene, a Playground render, or an upload. ${SC_SORT_TIP}">Kind${scArrow('kind')}</th>
      <th data-sort="origin" title="Where it came from — the chat for a scene, the voice for a Playground clip. ${SC_SORT_TIP}">From${scArrow('origin')}</th>
      <th data-sort="created_ts" title="${SC_SORT_TIP}">Built${scArrow('created_ts')}</th>
      <th data-sort="duration_s" title="${SC_SORT_TIP}">Length${scArrow('duration_s')}</th>
      <th></th></tr></thead><tbody>` +
      a
        .map(
          s =>
            `<tr data-ref="${esc(s.ref)}" data-kind="${esc(s.kind)}">
      <td><input type="checkbox" class="scSel" data-ref="${esc(s.ref)}" data-kind="${esc(s.kind)}"${scHas(s) ? ' checked' : ''}></td>
      <td><button class="xs scFav" data-act="fav" data-ref="${esc(s.ref)}" data-kind="${esc(s.kind)}" title="${s.favorite ? 'Starred. Click to un-star.' : 'Star this clip — then tick “★ favorites only” to see just these.'}" style="background:none;border:none;padding:0;cursor:pointer;color:${s.favorite ? 'var(--warn)' : 'var(--muted)'}">${s.favorite ? '★' : '☆'}</button></td>
      ${scWhoCell(s)}
      <td>${esc(s.name)}${s.enhanced ? ' <span class="pill ok" title="Enhanced, 256 kbps">enhanced</span>' : ''}</td>
      <td class="small muted">${SC_KIND_PILL[s.kind] || esc(s.kind)}</td>
      <td class="small muted scfrom" title="${esc(s.origin || '')}">${esc(s.origin || '')}${s.kind === 'scene' && s.n_entries ? ` · ${s.n_entries} msg` : ''}${s.n_skipped ? ` <span title="Messages with nothing speakable in them. Skipped, counted, and recorded in the manifest — never silently dropped (§9).">(+${s.n_skipped} skipped)</span>` : ''}</td>
      <td class="small muted scdate">${esc(String(s.created || '').replace('T', ' ') || (s.created_ts ? fmtDate(s.created_ts) : ''))}</td>
      <td class="sclen" title="${esc(scLenTip(s))}">${scFmtDur(s.duration_s)}${s.size ? ` <span class="small muted">${fmtSize(s.size)}</span>` : ''}</td>
      <td class="scacts">
        <button class="sm${scOwns(s) && scSounding() ? ' danger' : ''}" data-act="play" data-ref="${esc(s.ref)}" data-kind="${esc(s.kind)}" title="${esc(scPlayTip(s))}">${scPlayLabel(s)}</button>
        <button class="sm" data-act="copy" data-ref="${esc(s.ref)}" data-kind="${esc(s.kind)}" title="Copy this clip, then paste it into a scene's chapters to replace or insert a line">⧉ Copy</button>
        ${scSpeechCell(s)}
        ${
          s.kind === 'scene'
            ? `<button class="sm${scLib.open === s.ref ? ' primary' : ''}" data-act="chapters" data-ref="${esc(s.ref)}" title="Jump to any message inside the scene">Chapters</button>
        <button class="sm" data-act="rename" data-ref="${esc(s.ref)}">Rename</button>${scEnhCell(s)}`
            : ''
        }
        <a class="sm button" href="${esc(s.audio_url)}?download=1" title="Download this clip">⬇</a>
      </td></tr>` +
            // §10.5 — the player first, then the chapters: both belong to this row, and the player is
            // the one a chapter link two rows down is seeking.
            (scOwns(s) ? scPlayerRow(s) : '') +
            (s.kind === 'scene' && scLib.open === s.ref ? scDetailRow(s) : ''),
        )
        .join('') +
      '</tbody></table></div>'
    : // ⚠️ THE STRIP RENDERS ON THIS ARM TOO. With "enhanced only" or a narrow search active the
      // table can be empty while the queue is very much running — hiding the queue, the wait line
      // and the overnight failure report behind a filter made them look erased.
      scEnhStrip() +
      `<span class="muted">${
        scLib.items.length
          ? 'No clips match that filter.'
          : 'No clips yet — build a scene from SillyTavern (shift-click a ▶ button), or render something in the Playground.'
      }</span>`;
  const qBox = $('scEnhList');
  if (qBox && qTop) qBox.scrollTop = qTop;
  // The one <audio> was detached by the innerHTML above if it was living in a detail row. Put it
  // back before the browser gets a turn — see scPlace().
  scPlace();
  scSyncCharFilter(); // m4i / §9a.3 — the options follow the rows that are loaded
  scSyncSel();
}

// Delete and ⬇ Download-selected are SCENES ONLY, and act on the scene subset of whatever is
// ticked rather than refusing the whole selection. §7 makes this tab a view: deleting a
// Playground clip also has partials to consider, and an upload is training material — each
// belongs to the tab that owns those consequences. Join is the verb that works across all three.
const scScenesSel = () => scLib.sel.filter(s => s.kind === 'scene');

// 9.2.1 — ✨ Enhance selected. Bulk selection uses the same eligibility rules as the row action.
//
// 🔴 THE TICKED ROWS THE QUEUE WOULD ACTUALLY TAKE, WHICH IS NOT THE SAME AS THE TICKED ROWS. A
// selection routinely holds twins, Playground clips, and scenes already queued from the row
// button — and a button that counted all of them would say "(12)" and add four, which is the
// shape of every defect this tab has had: the UI promising what the code below does not keep. The
// filter is `scEnhCell`'s own rules, in the same order, so the bulk verb can never offer what the
// per-row verb refuses.
//
// ⚠️ RESOLVED AGAINST `scLib.items`, NOT READ OFF THE TICK. `scLib.sel` holds the row objects as
// they were when they were ticked; `loadScenes` replaces `items` when an enhancement finishes, so
// a stale `enhanced:false` in the selection would keep offering a scene that now has a twin.
// ⚠️ TICK ORDER IS PRESERVED, because that is this tab's rule for every bulk verb (§6.0-m2) and
// because it decides which of twelve scenes gets the first free card.
const scEnhSelectable = () =>
  enh.ok
    ? scScenesSel()
        .map(s => scLib.items.find(x => x.kind === 'scene' && x.ref === s.ref) || s)
        .filter(s => !s.enhanced && !scEnhQueued(s.ref) && !scLib.enh[s.ref])
    : [];

// The verb. ⚠️ It goes through `scEnhQueueMany` rather than pushing onto `enhQ` itself: that
// function IS the definition of "add to the queue" — it de-dupes, clears a previous refusal off the
// strip and sends the batch to the server in ONE request (11.2.7; it was one `scEnhQueue` per row
// while the tab owned the queue) — and a bulk path that reimplemented any of that would be a second
// definition to keep in step.
//
// 📌 THE SELECTION IS LEFT ALONE. Every row he ticked is now queued, so `scEnhSelectable()` is
// empty and the button disables itself — which is the feedback, and it is also what makes a
// double-press harmless. Clearing the ticks would additionally throw away a selection he may
// still want for ⬇ Download or ⛓ Join.
function scEnhSelected() {
  const rows = scEnhSelectable();
  if (!rows.length) return 0;
  scEnhQueueMany(rows.map(s => s.ref));
  return rows.length;
}

function scSyncSel() {
  const n = scLib.sel.length,
    ns = scScenesSel().length;
  /** @type {HTMLButtonElement} */ ($('scDelSel')).disabled = !ns;
  /** @type {VEl} */ ($('scDelSel')).textContent = ns ? `Delete selected (${ns})` : 'Delete selected';
  /** @type {HTMLButtonElement} */ ($('scDlSel')).disabled = !ns;
  /** @type {VEl} */ ($('scDlSel')).textContent = ns ? `⬇ Download selected (${ns})` : '⬇ Download selected';
  // 9.2.1 — and the count here is the ELIGIBLE subset, never `ns`: see scEnhSelectable. A box
  // that cannot enhance at all leaves the button disabled and unnumbered, the same refusal
  // `scEnhCell` makes on the row.
  const ne = scEnhSelectable().length;
  /** @type {HTMLButtonElement} */ ($('scEnhSel')).disabled = !ne;
  /** @type {VEl} */ ($('scEnhSel')).textContent = ne ? `✨ Enhance selected (${ne})` : '✨ Enhance selected';
  // One clip is not a join, so the verb stays off until there are two — otherwise Join is a
  // slow way to copy a file under a new name.
  /** @type {HTMLButtonElement} */ ($('scJoinBtn')).disabled = n < 2;
  /** @type {VEl} */ ($('scJoinBtn')).textContent = n ? `⛓ Join selected (${n})` : '⛓ Join selected';
  renderJoinTray();
}

// ── §7's Join tray ───────────────────────────────────────────────────────────────────────
function scJoinTotal() {
  const gap = Math.max(0, Number(/** @type {HTMLInputElement} */ ($('scJoinGap')).value) || 0);
  const secs = scLib.sel.reduce((t, s) => t + (s.duration_s || 0), 0) + gap * Math.max(0, scLib.sel.length - 1);
  return secs;
}

function renderJoinTray() {
  const n = scLib.sel.length;
  /** @type {VEl} */ ($('scJoinPanel')).style.display = n ? '' : 'none';
  if (!n) return;
  // A clip with no recorded duration makes the total a lower bound, and saying so is better
  // than quietly under-reporting a two-hour join.
  const unknown = scLib.sel.some(s => s.duration_s == null);
  /** @type {VEl} */ ($('scJoinTotals')).textContent =
    `— ${n} clip${n === 1 ? '' : 's'} · ${unknown ? 'at least ' : ''}${scFmtDur(scJoinTotal())}`;
  /** @type {VEl} */ ($('scJoinList')).innerHTML =
    `<div style="overflow-x:auto"><table class="pgtable"><tbody>` +
    scLib.sel
      .map(
        (s, i) => `<tr>
      <td style="width:28px" class="small muted">${i + 1}</td>
      <td>${esc(s.name)}</td>
      <td style="width:110px" class="small muted">${SC_KIND_PILL[s.kind] || esc(s.kind)}</td>
      <td style="width:70px">${scFmtDur(s.duration_s)}</td>
      <td style="width:110px;white-space:nowrap">
        <button class="xs" data-jup="${i}"${i === 0 ? ' disabled' : ''} title="Move up">↑</button>
        <button class="xs" data-jdn="${i}"${i === n - 1 ? ' disabled' : ''} title="Move down">↓</button>
        <button class="xs danger" data-jrm="${i}" title="Take out of the join">✕</button>
      </td></tr>`,
      )
      .join('') +
    '</tbody></table></div>';
}

/** @type {VEl} */ ($('scJoinList')).addEventListener('click', e => {
  const b = /** @type {HTMLButtonElement|null} */ (
    /** @type {HTMLElement} */ (e.target).closest('button[data-jup],button[data-jdn],button[data-jrm]')
  );
  if (!b) return;
  const a = scLib.sel;
  if (b.dataset.jup !== undefined) {
    const i = +b.dataset.jup;
    [a[i - 1], a[i]] = [a[i], a[i - 1]];
  } else if (b.dataset.jdn !== undefined) {
    const i = +b.dataset.jdn;
    [a[i + 1], a[i]] = [a[i], a[i + 1]];
  } else {
    a.splice(+(/** @type {string} */ (b.dataset.jrm)), 1);
  }
  renderScenes();
});

/** @type {VEl} */ ($('scFavOnly')).addEventListener('change', renderScenes);
/** @type {VEl} */ ($('scJoinGap')).addEventListener('input', renderJoinTray);
/** @type {VEl} */ ($('scJoinClear')).onclick = () => {
  scLib.sel = [];
  renderScenes();
};
/** @type {VEl} */ ($('scJoinBtn')).onclick = () => {
  /** @type {VEl} */ ($('scJoinName')).focus();
};

/** @type {ReturnType<typeof setInterval>|null} */
/** @type {ReturnType<typeof setInterval> | null} */
let scJoinTimer = null;
/** @type {string|null} */
let scJoinId = null;

// The escape hatch. A join in flight 409s every other one, so if a build wedges this is the
// only way back without restarting the server.
/** @type {VEl} */ ($('scJoinCancel')).onclick = async () => {
  if (!scJoinId) return;
  /** @type {HTMLButtonElement} */ ($('scJoinCancel')).disabled = true;
  try {
    await jpost(`/clips/join/${encodeURIComponent(scJoinId)}/cancel`, {});
  } catch (e) {}
  /** @type {VEl} */ ($('scJoinStatus')).textContent = 'Canceling…';
};

/** @param {boolean} on */
function scJoinBusy(on) {
  /** @type {HTMLButtonElement} */ ($('scJoinGo')).disabled = on;
  /** @type {VEl} */ ($('scJoinCancel')).style.display = on ? '' : 'none';
  /** @type {HTMLButtonElement} */ ($('scJoinCancel')).disabled = false;
}

/** @type {VEl} */ ($('scJoinGo')).onclick = async () => {
  const name = /** @type {HTMLInputElement} */ ($('scJoinName')).value.trim();
  if (scLib.sel.length < 2) {
    await modal('Nothing to join', 'Tick at least two clips.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  if (!name) {
    await modal('Name it', 'A joined scene needs a name.', [{ label: 'OK', class: 'primary', value: 1 }]);
    /** @type {VEl} */ ($('scJoinName')).focus();
    return;
  }
  scJoinBusy(true);
  /** @type {VEl} */ ($('scJoinStatus')).textContent = 'Joining…';
  let started;
  try {
    started = await jpost('/clips/join', {
      title: name,
      gap_s: Number(/** @type {HTMLInputElement} */ ($('scJoinGap')).value) || 0,
      items: scLib.sel.map(s => ({ kind: s.kind, ref: s.ref, name: s.name })),
    });
  } catch (err) {
    scJoinBusy(false);
    /** @type {VEl} */ ($('scJoinStatus')).textContent = '';
    await modal('Join failed', esc((err && /** @type {ErrLike} */ (err).message) || 'Could not start the join.'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  // Poll the same way the scene build is polled — one status shape, one idiom.
  clearInterval(scJoinTimer ?? undefined);
  scJoinId = started.job_id;
  scJoinTimer = setInterval(async () => {
    let st;
    try {
      st = await jget(`/clips/join/${encodeURIComponent(started.job_id)}`);
    } catch (e) {
      clearInterval(scJoinTimer ?? undefined);
      scJoinBusy(false);
      scJoinId = null;
      /** @type {VEl} */ ($('scJoinStatus')).textContent = 'Lost contact with the join.';
      return;
    }
    if (st.status === 'done' || st.status === 'failed' || st.status === 'canceled') {
      clearInterval(scJoinTimer ?? undefined);
      scJoinBusy(false);
      scJoinId = null;
      if (st.status === 'done') {
        /** @type {VEl} */ ($('scJoinStatus')).textContent = st.reencoded
          ? 'Joined — the clips had different formats, so they were re-encoded to match.'
          : 'Joined.';
        scLib.sel = [];
        /** @type {HTMLInputElement} */ ($('scJoinName')).value = '';
        await loadScenes();
      } else {
        /** @type {VEl} */ ($('scJoinStatus')).textContent = '';
        await modal(st.status === 'canceled' ? 'Join canceled' : 'Join failed', esc(st.error || 'The join did not finish.'), [
          { label: 'OK', class: 'primary', value: 1 },
        ]);
      }
      return;
    }
    /** @type {VEl} */ ($('scJoinStatus')).textContent =
      st.status === 'probing' ? `Checking the clips… ${st.done}/${st.total}` : st.reencoded ? 'Re-encoding and joining…' : 'Joining…';
  }, 1000);
};

// §5 — the chapter list. This is the ONE place conversation text is fetched, per scene, on
// demand; the list route deliberately does not carry it (§5.1).
//
// 6.1 §10.3 made it a toggle: the chapters open in a detail row under the one that was clicked
// and clicking Chapters again closes it. m0's scroll-into-view went with the panel — there is
// nothing to scroll to when the answer appears where you asked the question.
/** @param {string} ref */
async function scToggleChapters(ref) {
  if (scLib.open === ref) {
    scLib.open = null;
    renderScenes();
    return;
  }
  scLib.open = ref;
  renderScenes(); // opens straight away, on "Loading chapters…"
  // ⚠️ §10.5 REMOVED the silent player m0a attached here. It existed so a chapter link had
  // something to seek, and §10.4 already made the link start playback on its own — so all it did
  // was put a bar on screen nobody asked for. Worse, once ▶/■ became a toggle on that bar,
  // expanding chapters would have turned the row's button red without a note being played.
  // ⚠️ Lazy and PER ROW (§5.1): `entries` is the whole transcript and the list route
  // deliberately does not carry it. Cached once fetched, because renderScenes runs on every
  // keystroke in Search and re-fetching a manifest per keystroke is how you make a tab crawl.
  scNudgeOpen();
  if (scLib.chap[ref] !== undefined) return;
  try {
    const m = await jget(`/clips/scenes/${encodeURIComponent(ref)}/manifest`);
    scLib.chap[ref] = m.entries || [];
  } catch (e) {
    scLib.open = null;
    renderScenes();
    await modal('Chapters unavailable', 'Could not read that scene’s manifest.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  if (scLib.open !== ref) return; // he may have opened another one meanwhile
  renderScenes();
  scNudgeOpen();
} // the row grew when the chapters landed

// ⚠️ §10.1 made this necessary and it is not a walk-back of §10.3. Adding the SillyTavern
// sub-tab strip pushed the list down, and a row clicked near the bottom of the window opens its
// detail BELOW THE FOLD — which is m0's defect again, in a new place: a click whose only visible
// effect is off screen reads as a click that did nothing.
//
// 🔴 Only on OPEN, never inside renderScenes. renderScenes runs on every keystroke in Search,
// and a scroll there would yank the page around while he types.
//
// The row goes to the TOP rather than scrolling the detail into view, because that keeps the row
// he clicked on screen — he must not lose his place — and puts the most of its chapters below it.
// It fires only when the detail is not already fully visible, so the ordinary case does nothing
// at all, which is what §10.3 asked for.
function scNudgeOpen() {
  const det = /** @type {VEl} */ ($('scList')).querySelector('tr.scDet');
  if (!det) return;
  const r = det.getBoundingClientRect(),
    vh = window.innerHeight || 0;
  // 🔴 `stickTop()`, NOT `0` (9.0.8). The header is sticky and the tab bar pins under it, so a row
  // at `top: 40` is inside the viewport and behind the chrome — `>= 0` called that "already all
  // there" and declined to move, which is the click-that-did-nothing this function exists to stop.
  if (r.top >= stickTop() && r.bottom <= vh) return; // already all there — do nothing
  const row = det.previousElementSibling;
  // And it lands UNDER the chrome rather than flush with the viewport top, for the same reason.
  scrollUnderStick(row || det, 10, 'auto'); // 'auto' — this nudge has always been instant
}

// §10.5 — and the same for the player row, for the same reason: ▶ Play on the last row in the
// window would otherwise put the controls just below the fold, which is m0's defect again.
// `block:'nearest'` scrolls the minimum that brings it into view, so the row he clicked stays
// where it is in the ordinary case and nothing moves at all when the bar already fits.
function scNudgePlayer() {
  const p = /** @type {VEl} */ ($('scList')).querySelector('tr.scPlay');
  if (!p) return;
  const r = p.getBoundingClientRect(),
    vh = window.innerHeight || 0;
  if (r.top >= stickTop() && r.bottom <= vh) return;
  // ⚠️ `nearest` IS KEPT FOR THE BELOW-THE-FOLD CASE, deliberately — the note above says it is
  // chosen so the row he clicked stays where it is. Only the case it gets WRONG changes: a row
  // ABOVE the stick line, where `nearest` scrolls it flush to the viewport top and straight back
  // under the chrome.
  if (r.top < stickTop()) scrollUnderStick(p, 10, 'auto');
  else p.scrollIntoView({ block: 'nearest' });
}

/** @type {VEl} */ ($('scRefresh')).onclick = loadScenes;
/** @type {VEl} */ ($('scKindFilter')).addEventListener('change', renderScenes);
/** @type {VEl} */ ($('scEnhFilter')).addEventListener('change', renderScenes);
/** @type {VEl} */ ($('scCharFilter')).addEventListener('change', renderScenes); // m4i / §9a.3
// 🔴 filtWire, NOT a bare addEventListener. `filtRows` reads
// `FILT[id]`, and `FILT[id]` is written by filtWire and by nothing else, so the plain listener
// re-rendered on every keystroke with an empty query: the Clips search box has never filtered
// anything since 6.0 shipped it. Every other filter in the app is wired this way; this one was
// the exception. (It also brings the native ✕ and Escape, via the 'search' event.)
filtWire('scSearch', renderScenes);

// ── 9.5.6: the drag gesture on the enhancement queue ──────────────────────────────────────────
//
// 🔴 DELEGATED ON `#scList`, WHICH IS THE ONLY STABLE NODE HERE. `renderScenes` replaces its
// entire `innerHTML`, so a listener bound to a queue row is thrown away by the next render — and
// this list re-renders whenever an item is added, removed, started or finished. Drag events
// bubble, so one listener per phase covers every row that will ever exist.
//
// 🔴 AND THE HANDLERS DECIDE NOTHING. The ordering rule is `scEnhMove`, the repaint guard is
// `scEnhDragBegin`/`scEnhDragEnd`, and both are inside the range `clips_ui_smoke.mjs` runs in a
// bare vm — which has no `document` and cannot reach anything below this line. What is left here
// is exactly the geometry a headless vm could not answer anyway: which row the pointer is over,
// and which half of it.
//
// ⚠️ THE TARGET TRAVELS IN A MODULE VARIABLE, NOT IN `dataTransfer`. `ui/folders.js` records why:
// a `dragover` handler is forbidden from READING dataTransfer, and dragover is where the drop
// point is decided. `setData` is still called because a drag carrying no data is not a valid drag
// in Firefox. Committing the value dragover PAINTED, rather than recomputing it on drop, is also
// what guarantees the row lands where the blue rule said it would.
/** @type {string|null|undefined} the ref a drop would land BEFORE; null = the end, undefined = no drag */
let scEnhDropRef;

/** @param {Element} list */
function scEnhPaintDrop(list) {
  list.querySelectorAll('.scEnhDropBefore,.scEnhDropAfter').forEach(n => n.classList.remove('scEnhDropBefore', 'scEnhDropAfter'));
  if (scEnhDropRef === undefined) return;
  if (scEnhDropRef === null) {
    const rows = list.querySelectorAll('.scEnhItem');
    const last = rows[rows.length - 1];
    if (last) last.classList.add('scEnhDropAfter');
    return;
  }
  const el = list.querySelector(`.scEnhItem[data-ref="${CSS.escape(scEnhDropRef)}"]`);
  if (el) el.classList.add('scEnhDropBefore');
}

// Every exit from a drag comes through here — drop, dragend, and dragend after an Escape.
// ⚠️ IT CLEARS THE MARKS ITSELF rather than leaving them to the next render: a drop that changes
// nothing (dropped back where it started) does not render, and a blue insertion rule left painted
// on a list nobody is dragging is a UI that looks stuck.
function scEnhDragClear() {
  const list = $('scEnhList');
  if (list)
    list
      .querySelectorAll('.scEnhDropBefore,.scEnhDropAfter,.scEnhDragging')
      .forEach(n => n.classList.remove('scEnhDropBefore', 'scEnhDropAfter', 'scEnhDragging'));
  scEnhDropRef = undefined;
  scEnhDragEnd();
}

// 9.5.7 — the sortable headers. 🔴 `th[data-sort]`, NOT a bare `th`: the tick-all box lives in
// a `<th>` of its own, and matching every header would swallow its click so that ticking the
// page re-sorted the list instead.
//
// ⚠️ It is one of five delegated click listeners on `#scList` and it does not need to stop the
// others: a `<th>` is the one place in this table with no `data-ref`, and every one of them
// reads that attribute off a `closest()` of its own before it does anything.
/** @type {VEl} */ ($('scList')).addEventListener('click', e => {
  const th = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('th[data-sort]'));
  if (th) scSortBy(String(th.dataset.sort || ''));
});
scSortRestore(); // see scSortRestore — called HERE because the vm slice above has no `UIS`

/** @type {VEl} */ ($('scList')).addEventListener('dragstart', ev => {
  // ⚠️ NOT EVERY dragstart IN HERE IS OURS. Dragging a selection of text fires one too, with the
  // target somewhere inside the table — hence the closest() rather than a bare target check.
  const t = ev.target instanceof Element ? ev.target : null;
  const row = t && t.closest('.scEnhItem');
  const ref = row && row.getAttribute('data-ref');
  if (!row || !ref || row.getAttribute('draggable') === 'false') return;
  scEnhDragBegin(ref);
  row.classList.add('scEnhDragging');
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', ref); // Firefox refuses a drag with no data at all
  }
});

/** @type {VEl} */ ($('scList')).addEventListener('dragover', ev => {
  if (!scEnhDragRef) return;
  const t = ev.target instanceof Element ? ev.target : null;
  const list = t && t.closest('.scEnhList');
  if (!list) return;
  ev.preventDefault(); // "yes, you may drop here" — the ONLY way to say it
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  const row = t.closest('.scEnhItem');
  // 🔴 THE MIDPOINT OF THE ROW, NOT THE ROW. Without a half-test the last position in the list is
  // unreachable: every drop over the bottom row means "before it", so nothing can ever be made
  // last. Below the bottom row (over the box's own padding, where `row` is null) is the end too.
  let want = /** @type {string|null|undefined} */ (null);
  if (row) {
    const r = row.getBoundingClientRect();
    const above = ev.clientY < r.top + r.height / 2;
    const nextRow = above ? row : row.nextElementSibling;
    want = nextRow ? nextRow.getAttribute('data-ref') : null;
  }
  // 🔴 A GESTURE THAT WOULD CHANGE NOTHING GETS NO MARKER. Three hovers land on the row's own
  // position — either half of the row itself, and the bottom half of the row above it — and all
  // three resolve to "before the ref being dragged". Painting a blue insertion rule for those
  // promises a move that `scEnhMove` will then correctly refuse, which reads as a drag that did
  // not take. `undefined` is the third state the marker needs: not "the end", but "nowhere".
  if (want === scEnhDragRef || (row && row.getAttribute('data-ref') === scEnhDragRef)) want = undefined;
  if (want === scEnhDropRef) return; // dragover fires continuously; only repaint when it moved
  scEnhDropRef = want;
  scEnhPaintDrop(list);
});

/** @type {VEl} */ ($('scList')).addEventListener('drop', ev => {
  if (!scEnhDragRef) return;
  const t = ev.target instanceof Element ? ev.target : null;
  if (!t || !t.closest('.scEnhList')) return;
  ev.preventDefault(); // or the browser navigates to the text/plain payload
  const moved = scEnhDragRef;
  // `undefined` is "nowhere" (see the dragover handler), NOT "the end" — collapsing the two here
  // would send a row released on its own grip to the bottom of the queue.
  const before = scEnhDropRef;
  if (before === undefined) {
    scEnhDragClear();
    return;
  }
  // 🔴 CLEAR THE GUARD BEFORE THE MOVE, or `scEnhMove`'s own `renderScenes` is the render that
  // gets deferred and the list never repaints in its new order.
  scEnhDragClear();
  scEnhMove(moved, before);
});

// Fires whatever ended the drag — a drop, a release outside the list, or Escape — so this is what
// makes the repaint guard safe rather than a way to wedge the tab.
/** @type {VEl} */ ($('scList')).addEventListener('dragend', scEnhDragClear);

/** @type {VEl} */ ($('scList')).addEventListener('click', async e => {
  const all = /** @type {HTMLInputElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('#scSelAll'));
  if (all) {
    const on = all.checked;
    // Ticking the header adds the VISIBLE rows in the order they are shown, which is the same
    // promise as ticking them one by one: what you see top-to-bottom is what you get.
    for (const s of scFiltered()) {
      if (on) {
        if (!scHas(s)) scLib.sel.push(s);
      } else {
        const i = scLib.sel.findIndex(x => scKey(x) === scKey(s));
        if (i >= 0) scLib.sel.splice(i, 1);
      }
    }
    renderScenes();
    return;
  }
  const box = /** @type {HTMLInputElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.scSel'));
  if (box) {
    const row = scLib.items.find(s => s.kind === box.dataset.kind && s.ref === box.dataset.ref);
    if (row) {
      if (box.checked) {
        if (!scHas(row)) scLib.sel.push(row);
      } // tick order IS join order
      else {
        const i = scLib.sel.findIndex(x => scKey(x) === scKey(row));
        if (i >= 0) scLib.sel.splice(i, 1);
      }
    }
    scSyncSel();
    return;
  }
  const btn = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-act]'));
  if (!btn) return;
  const ref = btn.dataset.ref,
    kind = btn.dataset.kind;
  if (btn.dataset.act === 'play') {
    // §10.5 — the same button both ways round. Pressing it on the clip that already owns the
    // player stops it and puts the bar away, which is the only way to get rid of the bar.
    //
    // ⚠️ 9.6.7 — OWNERSHIP, DELIBERATELY, EVEN THOUGH THE LABEL NOW HAS THREE STATES. ■ Stop and
    // ✕ Close are one action wearing the right name for the moment (see `scPlayLabel`): both mean
    // "put the bar away", and the audio is only stopped because there is audio to stop. Gating
    // this on `scSounding` as well would make ✕ Close do nothing.
    if (scLib.playing && scLib.playing.kind === kind && scLib.playing.ref === ref) {
      scStop();
      return;
    }
    // Range-served, so scrubbing an hour-long scene works (store_serve.send_store_file). The
    // URL comes from the row, because each kind is served by its OWN route (clip_sources).
    const row = scLib.items.find(s => s.kind === kind && s.ref === ref);
    if (!row) return;
    // 🔴 Never build a second <audio>. scEnsurePlayer moves the one that exists, so ▶ Play on a
    // row whose chapters are open takes over the player already sitting in that row rather than
    // leaving two of them sounding at once.
    scEnsurePlayer(/** @type {string} */ (kind), /** @type {string} */ (ref), row.audio_url)
      .play()
      .catch(() => {});
    // 🔴 9.6.7 — PAINT NOW, DO NOT WAIT FOR THE `play` EVENT. `scEnsurePlayer` re-renders BEFORE
    // this line, at a moment when the element is still `paused` — so the row it just drew says
    // ▶ Play. `play()` clears `paused` synchronously, and this turns that into the red ■ in the
    // same task; the queued `play` event would repaint a frame later and leave a flicker on every
    // press. (If `play()` rejects — a policy block — `pause` fires and puts it straight back,
    // which is the honest answer.)
    scPaintPlayButtons();
    scNudgePlayer();
  } else if (btn.dataset.act === 'copy') {
    const row = scLib.items.find(s => s.kind === kind && s.ref === ref);
    if (row) scCopyClip(/** @type {string} */ (kind), /** @type {string} */ (ref), row.name);
  } else if (btn.dataset.act === 'speech') {
    // Keep the row in place while the shared import route copies it into Speech sources.
    scAddSpeech(/** @type {string} */ (kind), /** @type {string} */ (ref), btn);
  } else if (btn.dataset.act === 'chapters') {
    scToggleChapters(/** @type {string} */ (ref));
  } else if (btn.dataset.act === 'fav') {
    // 🔴 Optimistic, and then CORRECTED from the answer rather than assumed. The server owns
    // the set — two tabs open on this page would otherwise disagree about a star for as long
    // as neither reloaded — and a failed write must put the row back the way it was.
    // 🔴 RE-FIND in each callback; never write through a captured row. `loadScenes` REPLACES
    // `scLib.items`, so a load that lands between the click and the answer leaves the object
    // this closure is holding detached from the array the filter reads — the write succeeds,
    // silently, on nothing. The ordering guard on `loadScenes` is what stops a STALE load doing
    // that; this is what keeps a legitimate one (an enhance or a join finishing mid-click) from
    // stranding the correction. The two are separate defects and both were live.
    const find = () => scLib.items.find(x => x.kind === kind && x.ref === ref);
    const row = find();
    if (!row) return;
    const was = !!row.favorite;
    // 🔴 BUMP BEFORE THE WRITE AND AGAIN AFTER IT — see `scFavSeq` at `loadScenes`. Any
    // `/clips/items` answer still in flight was computed before this star and must not be believed;
    // the bump is what tells that load so. The click bump covers the window before the server has
    // answered, the answer bump the window after — a load landing in either one is now re-asked.
    scFavSeq++;
    row.favorite = !was;
    renderScenes();
    jpost('/clips/favorite', { kind, ref })
      .then(r => {
        scFavSeq++;
        const cur = find();
        if (cur) cur.favorite = !!r.favorite;
        renderScenes();
      })
      .catch(() => {
        scFavSeq++;
        const cur = find();
        if (cur) cur.favorite = was;
        renderScenes();
      });
  } else if (btn.dataset.act === 'enhance') {
    // 8.2.4 — the press ENQUEUES rather than starting. With an empty queue and nothing running
    // that is indistinguishable from the old behavior (the pump starts it immediately); with a
    // job in flight it is the whole feature.
    scEnhQueue(/** @type {string} */ (ref));
  } else if (btn.dataset.act === 'enhdequeue') {
    scEnhDrop(/** @type {string} */ (ref));
  } else if (btn.dataset.act === 'enhclear') {
    scEnhClear();
  } else if (btn.dataset.act === 'enhstopall') {
    scEnhStopAll();
  } else if (btn.dataset.act === 'enhcancel') {
    const live = scLib.enh[/** @type {string} */ (ref)];
    if (live) {
      jpost(`/clips/scenes/enhance/${encodeURIComponent(live.job)}/cancel`, {}).catch(() => {});
      live.text = 'Canceling…';
      renderScenes();
    }
  } else if (btn.dataset.act === 'rename') {
    // Inline editor in the cell, the same shape the Playground library uses — one idiom for
    // renaming a stored artifact, not two.
    // 🔴 nth-child(3), not (2): the star took a column of its own in 6.2 (it is not inside the
    // NAME cell, because this editor replaces that cell wholesale and would eat it).
    const cell = /** @type {HTMLElement} */ (/** @type {HTMLTableRowElement} */ (btn.closest('tr')).querySelector('td:nth-child(3)'));
    if (cell.querySelector('input')) return; // already editing
    const cur = (scLib.items.find(x => x.ref === ref) || /** @type {SceneRow} */ ({})).name || '';
    cell.innerHTML = `<span style="display:inline-flex;gap:6px;align-items:center">
      <input type="text" value="${esc(cur)}" style="width:240px">
      <button class="xs primary" data-scrensave="${esc(ref)}">✓</button>
      <button class="xs" data-screncancel="1">✕</button></span>`;
    const inp = /** @type {HTMLInputElement} */ (cell.querySelector('input'));
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') /** @type {HTMLElement} */ (cell.querySelector('[data-scrensave]')).click();
      if (ev.key === 'Escape') renderScenes();
    });
  }
});

// The two buttons the inline rename editor puts in the cell.
/** @type {VEl} */ ($('scList')).addEventListener('click', async e => {
  const save = /** @type {HTMLElement} */ (e.target).dataset.scrensave;
  if (save) {
    const inp = /** @type {HTMLInputElement} */ (
      /** @type {HTMLSpanElement} */ (/** @type {HTMLElement} */ (e.target).closest('span')).querySelector('input')
    );
    try {
      await jpost(`/clips/scenes/${encodeURIComponent(save)}/rename`, { name: inp.value.trim() });
    } catch (err) {
      await modal('Rename failed', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    loadScenes();
    return;
  }
  if (/** @type {HTMLElement} */ (e.target).dataset.screncancel) renderScenes();
});

// Clicking a chapter seeks the player — which is most of what makes a 46-minute scene usable.
//
// §10.4: it starts playback if needed. The link is inside that scene's own detail row, so the
// target is unambiguous.
/** @type {VEl} */ ($('scList')).addEventListener('click', e => {
  const a = /** @type {HTMLAnchorElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('a[data-seek]'));
  if (!a) return;
  e.preventDefault();
  const det = /** @type {HTMLElement|null} */ (a.closest('tr.scDet'));
  if (!det) return;
  const row = scLib.items.find(s => s.kind === 'scene' && s.ref === det.dataset.detref);
  if (!row) return;
  // 🔴 Read the offset BEFORE scEnsurePlayer: since §10.5 it re-renders when the owner changes,
  // which detaches the very <a> that was clicked.
  const at = Number(a.dataset.seek) || 0;
  scSeekPlay(scEnsurePlayer('scene', row.ref, row.audio_url), at);
  scPaintPlayButtons(); // 9.6.7 — same reason as the ▶ Play path: the re-render above predates the play()
  scNudgePlayer();
});

document.addEventListener('keydown', scSeekKey); // ← / → ±5 s while a clip is playing

// ── 6.1-m1b — staging edits ───────────────────────────────────────────────────────────────
//
// 🔴 THE CLIPBOARD IS THE PRIMARY MECHANISM, not the round-trip button (§3.1). An earlier draft
// cut it in favor of a single "↩ Use in <scene>" on the row he departed from, and that was
// wrong, because it only ever covered REPLACE: a clip made from scratch has no origin to return
// to — making a NEW line is exactly the case where he never left a row — and an insert's target
// is chosen while looking at the running order, not when he departed.
/**
 * @param {string} kind
 * @param {string} ref
 * @param {string} [name]
 */
export function scCopyClip(kind, ref, name) {
  scLib.clip = { kind, ref, name: name || ref };
  scRenderClipboard();
  // ⚠️ And in the PLAYGROUND too, because that is where Copy is usually pressed and the Clips
  // tab's own clipboard bar is two tab switches away. A copy with no visible effect where you
  // pressed it reads as a copy that did not happen — the same lesson as 6.1-m0's Chapters button.
  scRenderOrigin();
  if (scLib.open) renderScenes();
} // the paste buttons appear on every row

function scRenderClipboard() {
  const c = scLib.clip,
    el = $('scClipBar');
  if (!el) return;
  el.style.display = c ? '' : 'none';
  if (c)
    el.innerHTML =
      `<span class="small">📋 <b>${esc(c.name)}</b><span class="muted"> — ${esc(c.kind)} clip, ready to paste into a scene's chapters below</span></span>` +
      ` <button class="xs" id="scClipClear" title="Forget it">✕</button>`;
}

// §3 step 2 — ✎ Edit in Playground. A tab change plus JS state, never a navigation, which is what
// keeps the edit round trip within the current page rather than navigating away.
/**
 * @param {string} ref
 * @param {number} i
 */
function scEditInPlayground(ref, i) {
  const e = (scLib.chap[ref] || [])[i];
  if (!e) return;
  // The fallback is a "row not found" placeholder — only `.name` is ever read off it, and that
  // read already has its own `||ref`, so an absent field is harmless. Cast for the checker; `{}`
  // is not really a `SceneRow` and never claims to answer anything else.
  const s = scLib.items.find(x => x.kind === 'scene' && x.ref === ref) || /** @type {SceneRow} */ ({});
  scLib.origin = { ref, index: i, title: s.name || ref };
  /** @type {HTMLTextAreaElement} */ ($('pgText')).value = e.text || '';
  // 🔴 The manifest records `voice` as a FULL HOST PATH, not the bare value the select carries.
  // That is a known schema wart, left alone deliberately — changing it would invalidate every
  // manifest already on disk. So: exact match first, then basenames, and if NEITHER hits, leave
  // the select alone. Silently picking the wrong voice is worse than not picking one.
  const want = String(e.voice || '');
  if (want) {
    /** @param {string} v */
    const base = v => /** @type {string} */ (String(v).split(/[\\/]/).pop()).toLowerCase();
    const opts = [.../** @type {HTMLSelectElement} */ ($('pgVoice')).options];
    const hit = opts.find(o => o.value === want) || opts.find(o => base(o.value) === base(want));
    if (hit) /** @type {HTMLSelectElement} */ ($('pgVoice')).value = hit.value;
  }
  switchTab('playground');
  /** @type {VEl} */ ($('pgText')).focus();
  scRenderOrigin();
}

// The shortcut for the round trip that DID start from a row: copy-then-replace in one click
// instead of three. 🔴 It calls the same staging path as the buttons, so it cannot drift from it.
function scRenderOrigin() {
  const el = $('pgOriginBar');
  if (!el) return;
  const o = scLib.origin,
    c = scLib.clip;
  el.style.display = o || c ? '' : 'none';
  const bits = [];
  if (o) bits.push(`<span class="muted">Editing line ${o.index + 1} of <b>${esc(o.title)}</b>.</span>`);
  if (c) bits.push(`<span class="muted">📋 <b>${esc(c.name)}</b> is copied.</span>`);
  // The shortcut only makes sense when BOTH halves are present: a remembered row to go back to,
  // and something on the clipboard to put in it.
  if (o && c)
    bits.push(
      `<button class="xs primary" id="pgUseInScene" title="Stage the copied clip as a replacement for that line and go back to it">↩ Use in “${esc(o.title)}”</button>`,
    );
  if (o) bits.push(`<button class="xs" id="pgOriginClear" title="Forget where this came from">✕</button>`);
  el.innerHTML = bits.join(' ');
}

/**
 * @param {SceneEditVerb} op
 * @param {number} index
 * @param {{silent?:boolean}} [opts]
 */
async function scStage(op, index, opts) {
  const c = scLib.clip,
    ref = scLib.open;
  if (!c || !ref) return;
  const line = index + 1;
  const what =
    op === 'replace'
      ? `Replace line ${line} with <b>${esc(c.name)}</b>?`
      : `Insert <b>${esc(c.name)}</b> ${op === 'insert_before' ? 'before' : 'after'} line ${line}?`;
  if (!(opts && opts.silent)) {
    const ok = await modal(
      'Stage this edit',
      what +
        '<div class="small muted" style="margin-top:6px">Nothing is written until you press Apply, and Apply always writes a <b>new</b> scene — this one is untouched.</div>',
      [
        { label: 'Cancel', value: 0 },
        { label: 'Stage it', class: 'primary', value: 1 },
      ],
    );
    if (!ok) return;
  }
  const ops = (scLib.edits[ref] = scLib.edits[ref] || []);
  // 🔴 One replace per line. Two is not a merge, it is a contradiction — the server refuses it by
  // name, and letting him stage it only to be rejected at Apply is a worse way to find out. A
  // second replacement REPLACES the first, which is the only thing he can mean.
  if (op === 'replace') {
    const at = ops.findIndex(o => o.op === 'replace' && o.index === index);
    if (at >= 0) ops.splice(at, 1);
  }
  const src = (scLib.chap[ref] || [])[index] || /** @type {SceneEntry} */ ({}); // "no such entry" fallback; only `.text` is read, with its own `||''`
  ops.push({
    op,
    index,
    kind: c.kind,
    ref: c.ref,
    name: c.name,
    text: op === 'replace' ? src.text || '' : '',
  });
  renderScenes();
}

async function scApplyEdits() {
  const ref = scLib.open,
    // `ref &&` rather than a cast: the guard on the next line already knows ref can be null,
    // and `null || []` is the same `[]` that `edits[null] || []` produced.
    ops = (ref && scLib.edits[ref]) || [];
  if (!ref || !ops.length) return;
  const name = (($('scEditName') && /** @type {HTMLInputElement} */ ($('scEditName')).value) || '').trim();
  if (!name) {
    await modal('Name it', 'The edited scene needs a name.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  scLib.editName = name;
  const st = $('scEditStatus'),
    go = /** @type {HTMLButtonElement} */ ($('scEditApply')),
    cancel = $('scEditCancel');
  if (go) go.disabled = true;
  if (st) st.textContent = 'Stitching…';
  let job;
  try {
    job = await jpost(`/clips/scenes/${encodeURIComponent(ref)}/edit`, {
      title: name,
      ops: ops.map(o => ({ op: o.op, index: o.index, kind: o.kind, ref: o.ref, text: o.text })),
    });
  } catch (err) {
    if (go) go.disabled = false;
    if (st) st.textContent = '';
    await modal('Could not apply', esc(/** @type {ErrLike} */ (err).message || 'the edit was refused'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  if (cancel) cancel.style.display = '';
  scLib.editJob = job.job_id; // what the Cancel button cancels
  scEditPoll(job.job_id, ref);
}

/**
 * @param {string} jobId
 * @param {string} ref
 */
function scEditPoll(jobId, ref) {
  const tick = setInterval(async () => {
    let s;
    // 🔴 A 404 IS TERMINAL AND EVERYTHING ELSE IS NOT, AND COLLAPSING THE TWO LEFT THE PANE STUCK
    // FOREVER. This was a bare `catch(e){return;}`, which is right for a network blip or a 5xx —
    // the next tick retries and the edit carries on. But `scene_edit.JOBS` is IN-MEMORY, so a
    // service restart mid-edit loses the job and the route `abort(404)`s (web/clips.py:199). That
    // took the same branch: the poll never cleared and ran every 700 ms for the life of the page,
    // while Apply stayed disabled and the status line went on claiming "Cutting…" for a job that
    // no longer existed. The only way out was a reload, and nothing said so.
    // ⚠️ `e.status` is readable here because `util/http.js` throws a typed `HttpError` — 8.3 is
    // what made this branch expressible without guessing at the error's shape.
    try {
      s = await jget(`/clips/scenes/edit/${encodeURIComponent(jobId)}`);
    } catch (e) {
      if (!(e && /** @type {ErrLike} */ (e).status === 404)) return; // transient: keep polling
      clearInterval(tick);
      const go = /** @type {HTMLButtonElement} */ ($('scEditApply')),
        cancel = $('scEditCancel');
      if (go) go.disabled = false;
      if (cancel) cancel.style.display = 'none';
      const gone = $('scEditStatus');
      // Deliberately not a modal: this fires on a bounce the user did not ask about, and a dialog
      // demanding a click for "your edit is no longer running" is worse than a line that says it.
      if (gone) gone.textContent = 'The edit is no longer running — the server restarted. Nothing was written.';
      return;
    }
    const st = $('scEditStatus');
    if (s.status === 'done' || s.status === 'failed' || s.status === 'canceled') {
      clearInterval(tick);
      const go = /** @type {HTMLButtonElement} */ ($('scEditApply')),
        cancel = $('scEditCancel');
      if (go) go.disabled = false;
      if (cancel) cancel.style.display = 'none';
      if (s.status === 'done') {
        // The plan is spent. Keeping it staged would invite applying it twice, which is legal
        // (§9.8 — two applies make two scenes) but is never what he means right after one landed.
        scLib.edits[ref] = [];
        scLib.editName = '';
        // 🔴 Drop the NEW scene's chapters from the cache before listing: it did not exist when
        // the cache was built, but a rebuilt scene could reuse a ref, and a stale transcript
        // under a fresh name is the kind of wrong that reads as correct.
        delete scLib.chap[s.ref];
        await loadScenes();
        if (st) st.textContent = '';
        await modal('Edited', `Wrote <b>${esc(name_of(s.ref))}</b>. The original is untouched.`, [
          { label: 'OK', class: 'primary', value: 1 },
        ]);
      } else if (s.status === 'failed') {
        if (st) st.textContent = '';
        await modal('The edit failed', esc(s.error || 'something went wrong'), [{ label: 'OK', class: 'primary', value: 1 }]);
      } else if (st) st.textContent = 'Canceled — nothing was written.';
      return;
    }
    if (st) st.textContent = s.status === 'cutting' ? `Cutting… ${s.done}/${s.total}` : 'Stitching…';
  }, 700);
}

/** @param {string} ref */
const name_of = ref => (scLib.items.find(s => s.kind === 'scene' && s.ref === ref) || /** @type {SceneRow} */ ({})).name || ref;

/** @type {VEl} */ ($('scClipBar')).addEventListener('click', e => {
  if (/** @type {HTMLElement} */ (e.target).id === 'scClipClear') {
    scLib.clip = null;
    scRenderClipboard();
    scRenderOrigin();
    if (scLib.open) renderScenes();
  }
});

// §3.1's shortcut, and the ✕ next to it. 🔴 It goes through `scStage`, the same path the paste
// buttons use, so the one-click round trip cannot drift from the general one.
/** @type {VEl} */ ($('pgOriginBar')).addEventListener('click', e => {
  if (/** @type {HTMLElement} */ (e.target).id === 'pgOriginClear') {
    scLib.origin = null;
    scRenderOrigin();
    return;
  }
  if (/** @type {HTMLElement} */ (e.target).id !== 'pgUseInScene') return;
  const o = scLib.origin;
  if (!o) return;
  scLib.open = o.ref;
  switchTab('sillytavern');
  switchStTab('clips');
  // The chapters may not be cached if he never expanded this scene in this session — stage once
  // they are there, so the row it lands on is the row he departed from.
  const go = () => scStage('replace', o.index, { silent: true });
  if (scLib.chap[o.ref] !== undefined) {
    renderScenes();
    go();
  } else scToggleChapters(o.ref).then(go);
});

// The buttons inside an expanded scene: ✎, the three pastes, ✕ unstage, and the full-text toggle.
/** @type {VEl} */ ($('scList')).addEventListener('click', async e => {
  const det = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('tr.scDet'));
  if (!det) return;
  const ref = det.dataset.detref;
  const full = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-fulltext]'));
  if (full) {
    const k = `${ref}|${full.dataset.fulltext}`;
    scLib.full = scLib.full === k ? null : k;
    renderScenes();
    return;
  }
  const b = /** @type {HTMLButtonElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button'));
  if (!b) return;
  if (b.dataset.pgedit !== undefined) {
    scEditInPlayground(/** @type {string} */ (ref), +b.dataset.pgedit);
    return;
  }
  if (b.dataset.paste !== undefined) {
    const [op, i] = b.dataset.paste.split('|');
    // `data-paste` is written by this same file as `insert_before|i`/`replace|i`/`insert_after|i`
    // (scDetailRow) — always one of the three verbs. The cast says so; the split alone only
    // knows it produced a string.
    scStage(/** @type {SceneEditVerb} */ (op), +i);
    return;
  }
  if (b.dataset.unstage !== undefined) {
    (scLib.edits[/** @type {string} */ (ref)] || []).splice(+b.dataset.unstage, 1);
    renderScenes();
    return;
  }
  if (b.id === 'scEditApply') {
    scApplyEdits();
    return;
  }
  if (b.id === 'scEditName') return;
  if (b.id === 'scEditCancel') {
    const st = $('scEditStatus');
    if (st) st.textContent = 'Canceling…';
    try {
      await jpost(`/clips/scenes/edit/${encodeURIComponent(scLib.editJob || '')}/cancel`, {});
    } catch (err) {}
    return;
  }
});

/** @type {VEl} */ ($('scDelSel')).onclick = async () => {
  const scs = scScenesSel(),
    n = scs.length;
  if (!n) return;
  const others = scLib.sel.length - n;
  const ok = await modal(
    'Delete scenes',
    `Delete <b>${n}</b> scene${n === 1 ? '' : 's'}? This cannot be undone.` +
      (others
        ? `<div class="small muted" style="margin-top:6px">${others} other clip${others === 1 ? '' : 's'} in the selection ${others === 1 ? 'is' : 'are'} not a scene and will be left alone — delete a Playground clip in the Playground tab, an upload in the Speech tab.</div>`
        : ''),
    [
      { label: 'Cancel', value: 0 },
      { label: 'Delete', class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  const refs = scs.map(s => s.ref);
  // fetch directly, not jdel(): DELETE-with-a-body is what the route takes, and jdel sends
  // none. Same call the Playground's own multi-delete makes.
  try {
    const r = await fetchUnlocked('/clips/scenes', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenes: refs }),
    });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
  } catch (e) {}
  // Deleted what was playing, or what was expanded: drop both, and the cached chapters with
  // them, or a re-created scene of the same name would show the dead one's transcript.
  if (scLib.playing && scLib.playing.kind === 'scene' && refs.includes(scLib.playing.ref)) scStop();
  if (refs.includes(scLib.open || '')) scLib.open = null;
  for (const r of refs) delete scLib.chap[r];
  // Only the deleted ones leave the selection — anything else stays ticked for the join.
  scLib.sel = scLib.sel.filter(s => s.kind !== 'scene' || !refs.includes(s.ref));
  loadScenes();
};

// The same form-POST-into-a-hidden-iframe as the Playground's, and for the same reason: the
// response is an attachment, so the browser streams it to disk with its own progress and its
// own resume. A fetch()+blob would hold the whole selection in the tab, and a selection of
// scenes is measured in hours.
// 9.2.1 — ✨ Enhance selected. The work is `scEnhSelected` (up with the queue, inside the range
// tests/clips_ui_smoke.mjs slices into a vm); this line is the join, and it is asserted at two
// layers — the button exists in the page, and this wiring names it.
/** @type {VEl} */ ($('scEnhSel')).onclick = () => {
  scEnhSelected();
};

/** @type {VEl} */ ($('scDlSel')).onclick = () => {
  const refs = scScenesSel().map(s => s.ref);
  if (!refs.length) return;
  let fr = /** @type {HTMLIFrameElement} */ (/** @type {unknown} */ ($('scDlFrame'))); // see pg/playground.js for why the cast is doubled
  if (!fr) {
    fr = document.createElement('iframe');
    fr.id = 'scDlFrame';
    fr.name = 'scDlFrame';
    fr.style.display = 'none';
    document.body.appendChild(fr);
  }
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = '/clips/scenes/zip';
  f.target = 'scDlFrame';
  f.style.display = 'none';
  for (const r of refs) {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = 'scenes';
    i.value = r;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
  f.remove();
};
