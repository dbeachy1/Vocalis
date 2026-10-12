// voices/voices.js — the whole Voices tab: the uploaded/created list with its one shared player,
// the Create-a-voice design form, the language and length presets, and the voice-design templates
// (7.3-m8b, closing §5's m8).
//
// 718 lines out of SIX adjacent banners, one contiguous cut — `── Voices management ──`,
// `── the ONE shared voice player ──`, `── Create a voice (4.8-m2) ──`, `── Language (4.8-m4) ──`,
// `── Length (4.8-m4d) ──` and `── Voice-design templates (7.0-m7 §17) ──`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 🔴 §4 SAID THREE FILES — `list.js`, `create.js`, `templates.js` — AND TWO OF THE THREE EDGES ARE
// NOT THERE. Measured at 64208f9, the same way m7's boundary was:
//
//   `list.js` alone (Voices management → Create a voice)   201 lines  11 defs  4 leaks
//                                                          🔴 and TWO STRADDLING `let`s
//   this file's boundary                                   718 lines  29 defs  ✅ 2 leaks, 0 straddling
//
// The straddle is what decides it, exactly as `jobStart` decided m6c and `vsStart` decided m4m.
// `vcTab` is declared at the top of the LIST (renderVoiceList filters by it) and written by
// `switchVTab`, 450 lines below in the CREATE block. `vcTabWant` is declared beside it, written by
// the click handler on #vTabs and twice by the /health path that falls back to Upload when the
// VoxCPM2 venv is gone. Split them and each half declares its own copy: the list filters on one
// nothing writes while the tabs write one nothing reads, and there is no error to say so.
//
// 📌 `templates.js` HAS NO STRADDLE AND IS STILL NOT A FILE, for the m4l/m6a reason: the templates
// block and the design form call each other — a template APPLIES to the form's boxes
// (`vcTplApply` writes #vcPrompt/#vcSample), and the form's Save-as-template reads them back. Two
// halves of one card.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — TWO NAMES out of 29 definitions.
//
//   loadVoiceList     `switchTab`'s `if(name==='voices')`, still inline until `ui/tabs.js` at m2.
//   renderVoiceList   TWO callers, and both are outside this file for the same structural reason:
//                     `filtWire('vFilter', renderVoiceList)` sits in the page's one filter-wiring
//                     block, which belongs to no feature and cannot travel — so this is the THIRD
//                     name in 7.3 to need the arrow form, after `renderLibrary` (m4l) and
//                     `vsRenderLib` (m4p). And tests/voices_player_browser_spec.mjs drives it
//                     directly to prove a re-render cannot destroy a playing <audio> element.
//
// ⚠️ TWENTY-SEVEN NAMES STAY PRIVATE, including the entire template machinery, both preset tables
// and `switchVTab`. The measured leak count out of the 718-line range was exactly the two above.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ TWO NAMES LEAVE `_PARSE_TIME_SURFACE`'S SHAPE-3 GROUP, WHICH NOTHING HAD DONE BEFORE.
//
// Shape 3 is a top-level `let` that a parse-time `UIS.getItem` restore ASSIGNS, and the pin's note
// on it said they "cannot move into a module at all while the restore is inline: the module's
// binding and the page's would be two different variables". `vSort` and `vcTabWant` are the first
// two out, and the reason is the same one that has answered every other shape: **the restore
// statements are INSIDE the range.** They traveled with the declarations they write —
// `try{const s=UIS.getItem('vocalis-vsort');…}` sits two lines under `let vSort='added'` — so there
// is no inline writer left to disagree with the module's binding.
//
// 🔴 `vcTplState` LEAVES TOO, AND `renderVoiceList` DOES NOT. Both are bare-value wirings; the
// difference is only where the wiring statement lives. `vcTplState`'s three
// `$(id).addEventListener('input', vcTplState)` calls are in a `forEach` inside this range;
// `renderVoiceList`'s is in the filter block that serves ten features. That is the whole rule.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ THE PARSE-TIME IIFE COMES TOO, AND IT IS THE LAST ONE BUT `UIS`.
//
// `(function vcInitLang(){…})()` fills #vcLang and #vcLen from the two preset tables and restores
// the remembered choice. It ran during parsing; in a module it runs at module-execute time, after
// the DOM exists, which is strictly safer — nothing outside waits on it, and `switchVTab` (its only
// structural neighbor) is called from a click or from /health, never at load.
//
// 📌 IT WAS ALSO THE ONLY REMAINING PARSE-TIME READER OF THE INLINE `esc` (§3.1a). Deleting that
// duplicate is now a question the guard can answer rather than a judgment call — but it is NOT this
// commit: `$` still has 198 parse-time callers, and one duplicate at a time is how m13 did `wbEl`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT REACHES OUTWARD — 23 imported names, three read off the page.
//
// `UIS` (10 reads) and `MODELS` (2) can never be imported: §11.2 canceled `util/uistate.js` because
// `UIS` is a parse-time factory the page's own restores call, and §11.4 keeps `MODELS` inline
// because the /health poller REPLACES it. `state` is the page's shared object, m12's problem.
//
// ✅ `vc` IS AN IMPORT, NOT A REACH, AND THAT IS WHY THIS CUT IS ONE COMMIT. m8a took it out into
// js/voice/design.js on its own precisely so this file could import it alongside `loadCandidates`,
// `vcN`, `vcPoll` and `vcBatchPoll` without the cycle that declaring it here would have created.
// 🔴 That also means the design form's four `vc` sites are the last ones on the shim: the
// `voiceDesignMod` line in index.html's `Object.assign` is deleted in this commit, as its own
// comment predicted.
//
// ⚠️ tests/voices_ui_smoke.mjs SLICES THIS FILE TWELVE TIMES — 228 checks, more than any other
// harness. It was converted to `tests/_websrc.mjs` at m8b1, one commit ahead of this one, so every
// marker follows the code here instead of answering -1 (§3.5, and §11.6 item 4 which deferred it
// four milestones).
import { $, esc } from '../util/dom.js';
import { onVcSyncModel, onVoiceListLoad, vcTabNow, vcTabSet } from './vcstate.js'; // 7.5.6
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { state } from '../util/appstate.js'; // 7.3-m12d: was the page's last shared global
import { jget, jpost, jdel } from '../util/http.js';
import { modal, promptForName } from '../ui/modal.js';
import { favBtn, favFirst, favToggle } from '../ui/fav.js';
// 8.9: virtual folders. `voices_tts` is the scope — `/voices`, this tab alone. It is NOT
// `voices_rvc` (`/voiceswap/voices`, the Training and Voice-Swap voice lists): two registries,
// two lifecycles, two sets of folders, however similarly they read on screen.
import { folderRows, folderBar, folderGap, folderTag, folderWire, folderWireDrag, folderAddButton, loadFolders } from '../ui/folders.js';
import { byVoiceName } from '../ui/voicepicker.js';
import { MODELS } from '../sys/modelstate.js'; // 7.3-m12d: was an inline global (§11.4's last two)
import { filtRows, filtCount, filtNone, filtQ } from '../util/filter.js';
import { fmtDate, fmtSize } from '../util/fmt.js';
import { loadVoices } from '../sys/devices.js';
import { pollReady } from '../sys/model.js';
import { vc } from '../voice/design.js';
import { loadCandidates, vcN, vcPoll } from '../voice/candidates.js';
import { vcBatchPoll } from '../voice/batch.js';
// ── Voices management ───────────────────────────────────────────────────
// Which sub-tab is showing: 'upload' | 'create'. Declared HERE, above renderVoiceList, and
// not down in the Create-a-voice block where switchVTab lives — renderVoiceList reads it to
// filter the list by origin, and a `let` used above its declaration is a temporal-dead-zone
// ReferenceError the moment anything calls the renderer during script evaluation.
// `vcTab` moved to ./vcstate.js at 7.5.6 — see that file. Read it with `vcTabNow()`, write it
// 🔴 `vcTabNow()` is an accessor because `js/voice/batch.js` reads the current tab across this
// module boundary. `Object.assign(window,
// mod)` copies a value ONCE, which is what made a published `let` go stale; a real ES import is a
// LIVE binding and would track the reassignment perfectly well. §11.4 is about the shim, and the
// shim is gone — m12d already found that this constraint had been misread for nine milestones.
// The accessor is still the right shape here for two reasons that survive the shim:
//   * an imported binding is READ-ONLY at the importer, so exporting the `let` would advertise a
//     name that looks assignable from js/voice/batch.js and is not;
//   * `stTabNow()`/`stTabSet()` set the precedent for "which tab is showing" one file over, and
//     two different idioms for one question is how the next reader gets it wrong.
// with `vcTabSet()`; both are imported above.
// Which sub-tab to LAND on after a reload. The top-level tab has persisted since 4.1.
// 🔴 Parked rather than applied here: "create" only EXISTS once /health says VoxCPM2 is
// installed (vcSyncModel unhides its button), so switching to it during script evaluation would
// show a panel whose tab button is still hidden — a card you cannot navigate away from, and one
// that lies about the engine being there if the venv has since been removed. vcSyncModel spends
// the wish the moment availability is actually known, or drops it if the answer is no.
/** @type {'upload'|'create'|null} */
let vcTabWant = null;
try {
  const t = UIS.getItem('vocalis-vtab');
  if (t === 'upload' || t === 'create') vcTabWant = t;
} catch (e) {}
// The list's order, persisted beside vocalis-vtab and shared by BOTH sub-tabs (§16.5).
// Default "added" — recently-added voices appear first for immediate audition.
let vSort = 'added';
try {
  const s = UIS.getItem('vocalis-vsort');
  if (s === 'added' || s === 'name') vSort = s;
} catch (e) {}
// Favorites first, then the active order. Array.sort is stable, so ★ composes with either
// ordering for free: star a voice and it moves to the top of whatever is showing, disturbing
// nothing else. Name sorts on the DISPLAY name via the shared helper (§16.9a) — the server's
// list is filename-ordered, and a label is free to start with a different letter.
// 🔴 A star is a FLAG THE USER SET. It is never a character parsed out of a name: a voice
// genuinely called "★ Sarah.wav" sorts as the text "★ Sarah.wav" and gets no special position.
// This codebase has already shipped that bug once (kobold.sort_key) — not again, and not in a
// list that now has a real star sitting next to the fake one (§16.7).
/** @param {VoiceRow[]} list */
const vOrder = list => favFirst([...list].sort(vSort === 'name' ? byVoiceName : (x, y) => (y.added || 0) - (x.added || 0)));
// When it arrived. 🔴 An INFERRED date is never printed as a hard one (§16.3): a voice that
// predates add-date recording (or was hand-dropped) carries the file's mtime, which is near
// enough to sort by and not a fact to assert — so it gets a tilde, a dimmer style and a
// tooltip that says where the number came from. Sorting on it is fine; claiming it isn't.
/** @param {VoiceRow} v */
const vAddedHTML = v =>
  !v.added
    ? ''
    : v.added_exact
      ? ` · added ${esc(fmtDate(v.added))}`
      : ` · <span style="opacity:.65" title="Approximate. This voice predates Vocalis recording add-dates, so this is the file's own timestamp — near enough to sort by, but not a recorded fact.">added ~${esc(fmtDate(v.added))}</span>`;
export async function loadVoiceList() {
  // In-place refresh (rename/delete): keep the old rows until data arrives and pin the
  // scroll — collapsing to "Loading…" shrank the page and teleported the user to the top.
  if (!(/** @type {VEl} */ ($('vList')).dataset.loaded)) /** @type {VEl} */ ($('vList')).innerHTML = '<span class="muted">Loading…</span>';
  const y = window.scrollY;
  try {
    // 8.9 — both, then render once. The rows arrive already stamped with `.folder` (the server
    // knows this scope's stable key); this fetch is the folder NAMES and their order. A failed
    // folder fetch degrades to "no folders" inside `loadFolders` rather than throwing, so a
    // folders outage costs the flat pre-8.9 list and never the tab.
    state.vlist = await jget('/voices');
    await loadFolders(V_SCOPE);
    renderVoiceList();
    /** @type {VEl} */ ($('vList')).dataset.loaded = '1';
    window.scrollTo(0, y);
  } catch (e) {
    /** @type {VEl} */ ($('vList')).innerHTML = `<span class="drop">${esc(/** @type {ErrLike} */ (e).message)}</span>`;
  }
}
// Split out of the loader so the filter re-renders from what we already have — otherwise
// every keystroke would refetch /voices.
// ── 8.7: cleaning a voice ──────────────────────────────────────────────
//
// 🔴 THE BADGES COME OFF THE SIDECAR, NOT OFF THE AUDIO. Nothing about a WAV says whether a
// model has been over it, and the whole point is that the clean copy and its original sit side by
// side in this list. They are also drawn from what the job ACHIEVED, never from what was ticked:
// a de-reverb that comes back misaligned is skipped rather than fatal, and a badge claiming it
// would be a lie about a file the user is about to train on.
/** @param {any} v */
function vCleanBadges(v) {
  return (
    (v.dereverbed ? ' <span class="badge cleaned" title="The reverb was taken off this copy.">de-reverbed</span>' : '') +
    (v.enhanced ? ' <span class="badge cleaned" title="This copy has been through the enhancer.">enhanced</span>' : '')
  );
}
/** The per-row status line, written in place. 🔴 NOT a re-render: this ticks once a second, and
 * rebuilding `#vList` on a timer would kill an open rename box and the shared player with it —
 * the same class of bug 8.6.1 fixed on the stems library.
 * @param {string} name @param {string} text @param {string} [cls] */
function vCleanNote(name, text, cls) {
  const el = document.querySelector(`[data-vcnote="${CSS.escape(name)}"]`);
  if (!el) return;
  el.textContent = text ? ` · ${text}` : '';
  el.className = `small ${cls || 'muted'}`;
}
/** The ticked steps that did NOT run, each with its reason, as a paragraph for the finished
 * dialog. Empty string when every ticked step ran. Release audit 2026-10-11: with Enhance also
 * ticked, a de-reverb skipped for missing models ended "Voice cleaned … Enhanced." and the user
 * was never told, because the reason only reached the job log.
 * @param {unknown} skipped  `[{step, why}]` from the status route. @returns {string} */
export function vCleanSkippedHtml(skipped) {
  if (!Array.isArray(skipped) || !skipped.length) return '';
  const items = skipped
    .map(s => `<b>${esc(String((s && s.step) || 'A step'))}</b> was not done — ${esc(String((s && s.why) || 'no reason was given'))}.`)
    .join('<br>');
  return `<br><br><span class="bad">${items}</span><br><br>`;
}
/** @param {string} name @param {string} jid */
async function vCleanPoll(name, jid) {
  for (;;) {
    await new Promise(r => setTimeout(r, 1000));
    let j;
    try {
      j = await jget(`/voices/clean/status/${encodeURIComponent(jid)}`);
    } catch (e) {
      vCleanNote(name, `lost track of the cleaning (${/** @type {ErrLike} */ (e).message})`, 'small bad');
      return;
    }
    // 🔴 `note`, not the last LOG line: the log carries the separator's own INFO output and a
    // voice row is not a log viewer. See the note in voiceclean.log().
    const last = j.note || j.stage || 'working…';
    if (j.status === 'running') {
      vCleanNote(name, last);
      continue;
    }
    if (j.status === 'done') {
      vCleanNote(name, '');
      loadVoiceList();
      loadVoices(); // every picker on the page gains the new voice
      await modal(
        'Voice cleaned',
        `Saved as <b>${esc(j.voice)}</b>.<br><br>` +
          `${j.dereverbed ? 'Reverb removed. ' : ''}${j.enhanced ? 'Enhanced. ' : ''}` +
          vCleanSkippedHtml(j.skipped) +
          `The original is untouched — play them one after the other and keep whichever you prefer.`,
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
      return;
    }
    vCleanNote(name, '');
    if (j.status !== 'canceled')
      await modal('Cleaning failed', esc(j.error || 'the job ended without saying why'), [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
}
/** The name to propose for the copy. An UNLABELED voice falls back to its filename, and that
 * carries an extension — "voice.wav (clean)" is not a useful suggested label. Strip it here and
 * nowhere else: the row's own display keeps the extension because it is the file's identity; this
 * is a suggestion for a new voice.
 * @param {string} label */
function cleanName(label) {
  return `${String(label).replace(/\.[a-z0-9]{2,5}$/i, '')} (clean)`;
}
/** @param {string} name @param {string} label */
async function vCleanStart(name, label) {
  const go = await modal(
    'Clean this voice',
    `<div class="small muted">Runs the reference clip through one or both repair models and saves the result as a
     <b>new voice</b> — this one is never modified. Worth doing once per voice: Chatterbox conditions on the
     reference, so its reverb becomes part of the voice and comes back on every render made from it.</div>
     <label class="tickline"><input type="checkbox" id="vcDerev" checked><b>Remove reverb / echo</b>
       <span class="small muted">— brings her closer to the mic. Can also come back drier and duller; keep both and compare.</span></label>
     <label class="tickline"><input type="checkbox" id="vcEnh" checked><b>Enhance</b>
       <span class="small muted">— bandwidth extension, the same pass a Playground clip gets. Chatterbox still needs its own enhance afterward; this one repairs the SOURCE.</span></label>
     <label style="margin-top:12px">Save the cleaned copy as</label>
     <input type="text" id="vcName" value="${esc(cleanName(label))}" maxlength="60">`,
    [
      { label: 'Cancel', value: 0 },
      { label: '✨ Clean', class: 'go', value: 1 },
    ],
  );
  // Read the boxes while the dialog's DOM is still up — `modal` empties #mBody only when the
  // NEXT dialog opens, and nothing opens between the await above and these three lines.
  const dereverb = !!($('vcDerev') && /** @type {HTMLInputElement} */ ($('vcDerev')).checked);
  const enhance = !!($('vcEnh') && /** @type {HTMLInputElement} */ ($('vcEnh')).checked);
  const want = (($('vcName') && /** @type {HTMLInputElement} */ ($('vcName')).value) || '').trim();
  if (!go) return;
  if (!dereverb && !enhance) {
    await modal('Nothing to do', 'Tick at least one of the two — otherwise this would just copy the voice.', [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  if (!want) {
    await modal('Name it', 'The cleaned copy needs a name — it is how you will find it in every picker.', [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  try {
    const j = await jpost(`/voices/${encodeURIComponent(name)}/clean`, { dereverb, enhance, label: want });
    vCleanNote(name, 'cleaning…');
    vCleanPoll(name, j.job_id);
  } catch (e) {
    await modal(
      'Could not start',
      esc(
        /** @type {unknown} */ (
          /** @type {ErrLike} */ (e).body &&
            /** @type {unknown} */ (/** @type {ErrLike} */ (e).body.message || /** @type {ErrLike} */ (e).body.error)
        ) || /** @type {ErrLike} */ (e).message,
      ),
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
  }
}

// ── 8.9: the folder scope, and the tick set that feeds `⇥ Move selected here` ────────────
//
// 🔴 KEYED ON `v.name`, THE FILENAME, WHICH IS IMMUTABLE FOR LIFE (§14.6). Rename changes the
// LABEL; the file never moves. So this scope needs no `folders.rekey` hook and cannot silently
// unfile anything — unlike scenes and RVC voices, whose display name IS their key.
//
// ⚠️ THE SET SURVIVES RE-RENDERS ON PURPOSE, AND IS PRUNED TO WHAT IS ON SCREEN ON EVERY ONE.
// This list re-renders on a star, a sort, a filter keystroke, a rename and a delete, and losing
// your ticks to any of those would make selecting more than two rows impossible. But a tick on a
// row you cannot SEE silently widens the next move, so `renderVoiceList` drops every name that is
// not in the display array it is about to paint — deleted, filtered out, inside a closed folder,
// or on the other sub-tab. 8.9.13: it used to prune against `state.vlist`, which caught the
// deletes and nothing else.
const V_SCOPE = 'voices_tts';
/** @type {Set<string>} */
const vSel = new Set();
const vSelected = () => [...vSel];

export function renderVoiceList() {
  // Filtered by the active sub-tab's ORIGIN (§14.5) — an uploaded voice has no business on
  // the Create tab. `all` is the origin's slice, so the "N of M" count describes the list you
  // are actually looking at rather than the whole store.
  const want = vcTabNow() === 'create' ? 'created' : 'uploaded';
  const all = (state.vlist || []).filter(v => (v.origin || 'uploaded') === want);
  /** @type {VEl} */ ($('vListTitle')).textContent = want === 'created' ? 'Created voices' : 'Uploaded voices';
  const shown = vOrder(filtRows('vFilter', all, v => `${v.label || ''} ${v.name}`));
  /** @type {VEl} */ ($('vTotals')).textContent = filtCount('vFilter', shown.length, all.length, 'voice');
  // 🔴 DETACH the open player before the innerHTML below destroys it, and put the SAME NODE
  // back afterward (vRestorePlayer). Every re-render of this list — switchVTab, the ★ toggle,
  // the sort, a rename, an upload, ↻ — replaces #vList wholesale, and it took the player with
  // it MID-LOAD: the browser-driven spec caught the element vanishing 200 ms after ▶, still at
  // readyState 0, which is a bar showing 00:00 that never plays and ignores its seek. Re-CREATING
  // it here would fix the disappearance and still be wrong — a new element restarts from zero,
  // so a favorite toggled during playback would jump the audio back to the start. Moving the
  // node keeps it playing across the re-render.
  const keep = vDetachPlayer();
  // A row carries a ▶ BUTTON, never its own <audio>. It used to embed a player per voice with
  // preload="metadata", so opening the tab fired one media request per voice; at 26 voices that
  // saturated Chrome's ~6-connections-per-host budget and the row you actually pressed play on
  // sat queued behind preloads for voices you never asked to hear — it would not start until a
  // scrub-bar click tore that request down and re-issued it. ▶ now opens the ONE shared player
  // (vTogglePlayer) on the line below, in this same card, so the tab costs zero media requests
  // until you ask for audio. The rationale lives here rather than in the template because a
  // comment inside the row markup is re-emitted into the DOM once per voice.
  // 8.9 — folders before, the open one's children, folders after, divider, unfiled. One flat
  // array; see `ui/folders.js`. A typed filter collapses the folders and flattens the hits,
  // because a search that answers "Nothing matches" while the voice sits in a closed folder is
  // indistinguishable from the voice not existing.
  const disp = folderRows(V_SCOPE, shown, { query: filtQ('vFilter') });
  // 8.9.13 — 🔴 THE TICKS ARE PRUNED TO WHAT IS ACTUALLY ON SCREEN, ON EVERY RENDER, AND THE
  // MEASURE IS `disp` RATHER THAN THE STORE. This was `state.vlist` — i.e. "is the voice still
  // installed" — which drops a tick only when the voice is DELETED. Everything else that takes a
  // row off the screen left its tick behind, invisible and still armed: type a filter and the
  // hidden rows still travel with `⇥ Move selected here`; close a folder and its children do
  // too; switch to the Created sub-tab and the Uploaded ticks are still in the set. A tick you
  // cannot see silently widens the next move, which is the one failure mode a tick set has.
  //
  // ⚠️ `disp`, NOT `shown` — a row inside a CLOSED folder is in `shown` and is not on screen.
  // Pruning against `shown` would have looked right and left exactly the invisible ticks above.
  //
  // 📌 The set still survives a re-render for every row that is STILL THERE, which is the whole
  // reason it is a `Set` and not a DOM read: this list repaints on a star, a sort, a rename and
  // an upload, and losing your ticks to any of those makes selecting more than two rows
  // impossible. Pruned here, after `disp` is built and before the rows are painted, so the
  // `checked` attributes below are written from the set that has already been narrowed.
  /** @type {Set<string>} */
  const onScreen = new Set();
  for (const e of disp) if (e.t === 'item') onScreen.add(e.row.name);
  for (const n of [...vSel]) if (!onScreen.has(n)) vSel.delete(n);
  // 🔴 THE BUTTON FOLLOWS THE PRUNE, NOT THE CLICK (9.7.2). `🗑 Delete selected` is armed by the
  // tick set, and the prune above is the ONE place a tick disappears without anyone touching a
  // checkbox — close a folder, type a filter, switch sub-tab. Syncing only in the `change` handler
  // would leave the button reading "(6)" over a selection the same render had just cut to two.
  vSyncBulk();
  /** @type {VEl} */ ($('vList')).innerHTML =
    disp.map(e => (e.t === 'folder' ? folderBar(e, { selectable: true }) : e.t === 'gap' ? folderGap() : vRow(e.row, e.in))).join('') ||
    (all.length
      ? filtNone('vFilter')
      : `<span class="muted">${want === 'created' ? 'No created voices yet — design one above.' : 'No uploaded voices.'}</span>`);
  vRestorePlayer(keep);
}

/**
 * One voice row.
 * @param {any} v
 * @param {string} [inFolder] - the folder's NAME, present only when a filter has flattened the
 *   list. Without the tag a flat result set silently loses the one thing folders added.
 *   (ASCII hyphen after an optional `[param]` — TS1127 rejects an em-dash there; see
 *   `ui/folders.js`'s note on `folderBar`.)
 */
function vRow(v, inFolder) {
  return `<div class="item" data-vrow="${esc(v.name)}" draggable="true"><label class="vpick" title="Tick this voice, then press “⇥ Move selected here” on a folder"><input type="checkbox" class="vchk" value="${esc(v.name)}"${vSel.has(v.name) ? ' checked' : ''}></label><div class="grow">
      <!-- The label is the display identity; an unlabeled voice falls back to its full filename,
           including the extension. -->
      <div class="t">${esc(v.label || v.name)}${vCleanBadges(v)}</div>
      <div class="m">${esc(v.name)} · ${fmtSize(v.size)}${vAddedHTML(v)}<span class="small" data-vcnote="${esc(v.name)}"></span></div></div>
    ${favBtn('vfav', v.name, v.favorite)}
    <button class="sm ok" data-vplay="${esc(v.name)}" title="Play this voice sample">▶</button>
    <a class="sm dl" href="/voices/${encodeURIComponent(v.name)}/audio?download=1" title="Download this voice. It saves under its NAME, not the on-disk filename.">⬇</a>
    <button class="sm" data-vclean="${esc(v.name)}" data-label="${esc(v.label || v.name)}" title="Take the reverb off this voice and/or run it through the enhancer, and save the result as a NEW voice you name. The original is never touched. Worth doing once per voice: Chatterbox conditions on the reference clip, so its reverb becomes part of the voice and comes back on every render made from it - cleaning the source fixes every future render at once.">✨ Clean</button>
    <button class="sm" data-ren="${esc(v.name)}" data-label="${esc(v.label || '')}" title="Rename the display label. The FILE never changes — everything (settings, Nomi map, books, clips) stays keyed to it.">✏ Rename</button>
    <button class="sm danger" data-del="${esc(v.name)}">🗑</button>${folderTag(inFolder || '')}</div>`;
}
// ── the ONE shared voice player ───────────────────────────────────────────────
// It lives in whichever row you last pressed ▶ on and nowhere else: opening it in a new row
// removes it from the old one, so only one voice is ever loaded, and the tab now costs ZERO
// media requests until you ask for audio.
//
// A FRESH <audio autoplay> node every time, never one persistent element re-pointed at a new
// src: Chrome silently no-ops a programmatic .play() on a re-pointed element, but honors the
// autoplay attribute on a newly inserted node because it rides the click's user gesture. The
// speech library learned this the hard way and does the same (see the ▶ branch in spList).
/**
 * @param {string} name
 * @param {HTMLElement|null} [row]
 */
function vTogglePlayer(name, row) {
  const reopening = row && row.querySelector('.vplayer');
  document.querySelectorAll('#vList .vplayer').forEach(n => n.remove());
  if (reopening || !row) return; // ▶ on the row that already has it = dismiss
  const slot = document.createElement('div');
  slot.className = 'vplayer';
  slot.dataset.for = name; // which row to put it back in after a re-render
  slot.innerHTML = `<audio controls autoplay src="/voices/${encodeURIComponent(name)}/audio"></audio>`;
  row.appendChild(slot); // a full-width line of this same card
  // autoplay is what carries it in Chrome — the node is new and the click is still the live
  // user gesture. Ask explicitly as well: other browsers honor the attribute less reliably on
  // a just-inserted node, and the rejection is swallowed rather than left as an uncaught promise.
  /** @type {HTMLAudioElement} */ (slot.querySelector('audio')).play().catch(() => {});
}
// The two halves of surviving a re-render. Detach returns the live node (or null); restore puts
// that exact node back in the row it belongs to, so the audio never stops. If its voice is no
// longer on screen — deleted, filtered out, or on the other sub-tab — it is simply dropped.
function vDetachPlayer() {
  const p = /** @type {VEl} */ ($('vList')).querySelector('.vplayer');
  if (p) p.remove(); // remove() DETACHES; the node and its audio live on
  return p;
}
/** @param {Element|null} p */
function vRestorePlayer(p) {
  if (!p) return;
  const btn = [...document.querySelectorAll('#vList .item [data-vplay]')].find(
    b => /** @type {HTMLElement} */ (b).dataset.vplay === /** @type {HTMLElement} */ (p).dataset.for,
  );
  if (btn) /** @type {HTMLElement} */ (btn.closest('.item')).appendChild(p);
}
/** @type {VEl} */ ($('vRefresh')).onclick = () => {
  loadVoiceList();
  loadVoices();
};
// ── 8.9: the folder controls on this list ────────────────────────────────────────────────
// The ✚ Folder button is BUILT here, not written into index.html — that page has a hard line
// ceiling and ten hand-written buttons would be ten small arguments for raising it.
//
// 🔴 8.9.13 — THE 4TH ARGUMENT ADDS `⇤ Remove from folder`, and without it
// this list had no way back out at all. Filing had two gestures (tick + `⇥ Move selected here`,
// or drag onto the folder); un-filing had one, dragging onto a divider that `folderRows` did not
// even emit once every row was filed — which is precisely the state using folders gets you to.
// 🔴 ONE RELOAD FOR THE ROW ACTIONS, THE DRAG AND THE TOOLBAR, AND `⇤ Remove from folder` IS A
// `move` LIKE ANY OTHER. Getting that wrong is invisible: un-filing changes the server's
// assignment, but every row's `.folder` stamp came down WITH the row, so a callback that merely
// re-rendered would paint the rows straight back into the folder they were just taken out of —
// store right, screen wrong, self-correcting on the next unrelated refresh, i.e. surfacing later
// as a bug report about something else. `create` is the one action that does NOT need the round
// trip: `folderCreate` has already refreshed the folder names, and no row's stamp changed.
//
// ⚠️ WHICH IS ALSO WHY THE TICKS ARE CLEARED ON `move` AND NOT ON `create`. ✚ Folder is the
// obvious partner of a selection — "tick six voices, then make somewhere to put them" — and
// clearing there would throw the set away at exactly the moment it was about to be used.
/** @param {string} act */
const vFolderReload = async act => {
  if (act === 'move') vSel.clear(); // the ticked rows have gone where they were sent
  // Opening a folder is UI state and changes nothing on the server, so it repaints from the
  // rows already in hand. Everything else invalidated the server's `.folder` stamps.
  if (act === 'open' || act === 'create') renderVoiceList();
  else await loadVoiceList();
};
folderAddButton(V_SCOPE, 'vRefresh', vFolderReload, { selected: vSelected });
// Delegated on the container so it survives every re-render — the folder header buttons are
// re-emitted on each one. See `folderWire`'s note on why `reload` is told which action fired.
folderWire('vList', V_SCOPE, {
  reload: vFolderReload,
  selected: vSelected,
  // Read at CLICK time, never captured: the delete confirm has to name how many voices are in
  // the folder it is about to remove, and that number changes under it.
  counts: () => {
    /** @type {Record<string, number>} */
    const n = {};
    for (const v of state.vlist || []) if (v.folder) n[v.folder] = (n[v.folder] || 0) + 1;
    return n;
  },
});
// The second gesture uses the same verb and destination — dragging a ticked row takes the whole tick set,
// dragging an unticked one takes only itself.
folderWireDrag('vList', V_SCOPE, { reload: vFolderReload, selected: vSelected });
// A tick needs no re-render — the checkbox already shows it — so this deliberately does NOT
// repaint. Repainting here would also destroy the open player mid-tick for nothing.
/** @type {VEl} */ ($('vList')).addEventListener('change', e => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (!t.classList || !t.classList.contains('vchk')) return;
  if (t.checked) vSel.add(t.value);
  else vSel.delete(t.value);
  vSyncBulk();
});

// ── 🗑 Delete selected (9.7.2) ────────────────────────────────────────────────
//
// 🔴 THE SELECTION ALREADY EXISTED AND HAD EXACTLY ONE VERB. 8.9 put a checkbox on every row for
// `⇥ Move selected here`, so you could tick thirty voices and file them in one gesture — and then
// remove them only one at a time, through a per-row 🗑 that asks its own question every time. The
// missing piece was never the ticks or the route; it was that nothing else was ever wired to the
// set. This is that wiring.
//
// ⚠️ THE BUTTON SITS NEXT TO ↻, NOT ON THE FOLDER BAR, because it acts on the LIST rather than on
// a folder — `⇥ Move selected here` and `⇤ Remove from folder` are a folder's verbs and are
// rendered per folder row; this one is the list's.
//
// 📌 AND ITS MARKUP IN `panel-voices.html` CARRIES NO COMMENT AT ALL, WHICH IS DELIBERATE. That
// partial is size-pinned at exactly its current length (`test_webui_size.py` — it may shrink, never
// grow), and the pin is not arbitrary: an HTML comment is bytes on the wire, shipped to every
// browser on every load, while this one is in a module the bundler serves once. The rationale for
// a control belongs wherever it is free, so `#vDelSel` is markup over there and prose over here.
// The button shares its line with `#vRefresh` for the same reason, which is also how the
// SillyTavern panel's toolbars are already written.
//
// ⚠️ IT SERVES BOTH SUB-TABS, WHICH IS WHY IT LIVES ON THE LIST AND NOT ON THE CREATE PANE.
// `renderVoiceList` filters one store by origin, so Uploaded and Created are two views of the same
// rows — a delete that only worked on one of them would be a second thing to explain, and the tick
// set does not know which tab it was filled on.

/** Keep the button's label and enabled state honest about the selection. */
function vSyncBulk() {
  const b = /** @type {HTMLButtonElement} */ (/** @type {unknown} */ ($('vDelSel')));
  if (!b) return;
  const n = vSel.size;
  b.disabled = !n;
  b.textContent = n ? `🗑 Delete selected (${n})` : '🗑 Delete selected';
}

/** The bytes a set of names accounts for, for the confirm. Unknown names contribute nothing. */
/** @param {string[]} names */
function vSelBytes(names) {
  const byName = new Map((state.vlist || []).map(v => [v.name, v]));
  return names.reduce((t, n) => t + ((byName.get(n) || {}).size || 0), 0);
}

/** @type {VEl} */ ($('vDelSel')).addEventListener('click', async () => {
  const names = vSelected();
  if (!names.length) return;
  const ok = await modal(
    'Delete voices',
    `Delete ${vcN(names.length, 'voice')} (${fmtSize(vSelBytes(names))})?<br><br>` +
      // 🔴 THE SAME WARNING THE SINGLE DELETE GIVES, because the consequence is the same and it
      // scales with the count rather than going away: any of these referenced by a Nomi or
      // SillyTavern character leaves that character falling back to the default voice.
      `Any that are referenced by a Nomi or SillyTavern character will leave those characters ` +
      `falling back to the default voice.<br><br>` +
      `<span class="muted small">${names.map(esc).join('<br>')}</span>`,
    [
      { label: 'Cancel', value: 0 },
      { label: `Delete ${names.length}`, class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;

  // 🔴 ONE AT A TIME, AND EVERY OUTCOME IS KEPT. `Promise.all` would fire N deletes at a server
  // that unlinks a file and a sidecar per call, and — worse for the report — a single rejection
  // would lose the outcome of every sibling. Sequential is fast enough for a hand-made selection
  // and lets the summary name exactly which ones did not go.
  /** @type {string[]} */ const gone = [];
  /** @type {string[]} */ const inUse = [];
  /** @type {string[]} */ const failed = [];
  for (const name of names) {
    try {
      const rr = await fetch('/voices/' + encodeURIComponent(name), { method: 'DELETE' });
      const r = await rr.json().catch(() => ({}));
      if (!rr.ok) throw new Error(r.error || rr.statusText);
      gone.push(name);
      if (r.in_use) inUse.push(name);
    } catch (e) {
      failed.push(`${name} — ${/** @type {ErrLike} */ (e).message}`);
    }
  }
  // ⚠️ CLEAR ONLY WHAT ACTUALLY WENT. A blanket `vSel.clear()` would drop the ticks on the rows
  // that FAILED, which are precisely the ones he needs to still see selected to try again.
  for (const n of gone) vSel.delete(n);

  await loadVoiceList();
  loadVoices(); // the pickers elsewhere are keyed on these names
  vSyncBulk();

  // 🔴 SAY WHAT HAPPENED WHENEVER ANYTHING DID NOT GO PERFECTLY. A silent partial success is the
  // shape that gets discovered later as "I thought I deleted those".
  if (failed.length || inUse.length) {
    await modal(
      failed.length ? 'Deleted with problems' : 'Deleted (some were in use)',
      (gone.length ? `Deleted ${vcN(gone.length, 'voice')}.<br><br>` : '') +
        (inUse.length
          ? `Referenced by a Nomi or SillyTavern character — update those mappings:<br>` +
            `<span class="muted small">${inUse.map(esc).join('<br>')}</span><br><br>`
          : '') +
        (failed.length ? `<b>Not deleted:</b><br><span class="muted small">${failed.map(esc).join('<br>')}</span>` : ''),
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
  }
});
/** @type {HTMLSelectElement} */ ($('vSort')).value = vSort;
/** @type {VEl} */ ($('vSort')).onchange = e => {
  vSort = /** @type {HTMLSelectElement} */ (e.target).value;
  try {
    UIS.setItem('vocalis-vsort', vSort);
  } catch (e2) {}
  renderVoiceList();
}; // re-sorts what we already have — no refetch
/** @type {VEl} */ ($('vList')).addEventListener('click', async e => {
  // ★ — reload BOTH lists, not just this one: favorites float to the top of the Book,
  // Playground, Nomi, ST and Bulk dropdowns too (§16.9), so a star set here reorders them.
  const fav = /** @type {HTMLElement} */ (e.target).dataset.vfav;
  if (fav) {
    const v = (state.vlist || []).find(x => x.name === fav);
    await favToggle('/voices/' + encodeURIComponent(fav) + '/favorite', !!(v && v.favorite), async () => {
      await loadVoiceList();
      await loadVoices();
    });
    return;
  }
  // ▶ — open the one shared player on the line below this row (see vTogglePlayer).
  const vp = /** @type {HTMLElement} */ (e.target).dataset.vplay;
  if (vp) {
    vTogglePlayer(vp, /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.item')));
    return;
  }
  // ✨ Clean — de-reverb and/or enhance into a NEW voice (8.7).
  const vc2 = /** @type {HTMLElement} */ (e.target).dataset.vclean;
  if (vc2) {
    vCleanStart(vc2, /** @type {HTMLElement} */ (e.target).dataset.label || vc2);
    return;
  }
  const del = /** @type {HTMLElement} */ (e.target).dataset.del,
    ren = /** @type {HTMLElement} */ (e.target).dataset.ren,
    rs = /** @type {HTMLElement} */ (e.target).dataset.rensave;
  if (del) {
    const ok = await modal(
      'Delete voice',
      `Delete <b>${esc(del)}</b>? If it's referenced by a Nomi or SillyTavern character, playback there will fall back to the default voice.`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Delete', class: 'danger', value: 1 },
      ],
    );
    if (!ok) return;
    try {
      const rr = await fetch('/voices/' + encodeURIComponent(del), { method: 'DELETE' });
      const r = await rr.json().catch(() => ({}));
      if (!rr.ok) throw new Error(r.error || rr.statusText);
      if (r.in_use)
        await modal(
          'Deleted (was in use)',
          `${esc(del)} was referenced by a Nomi or SillyTavern character — update the mapping to avoid a broken reference.`,
          [{ label: 'OK', class: 'primary', value: 1 }],
        );
      loadVoiceList();
      loadVoices();
    } catch (e2) {
      await modal('Delete failed', esc(/** @type {ErrLike} */ (e2).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    return;
  }
  // Rename IN PLACE — cosmetic label only; the file (and every key on it) is untouched.
  if (ren) {
    const t = /** @type {HTMLElement} */ (
      /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('.item')).querySelector('.t')
    );
    if (t.querySelector('input')) return; // already editing
    t.innerHTML = `<span style="display:inline-flex;gap:6px;align-items:center">
      <input type="text" value="${esc(/** @type {HTMLElement} */ (e.target).dataset.label || '')}" placeholder="${esc(ren)}" style="width:260px">
      <button class="xs primary" data-rensave="${esc(ren)}">✓</button>
      <button class="xs" data-rencancel="1">✕</button></span>`;
    const inp = /** @type {HTMLInputElement} */ (t.querySelector('input'));
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') /** @type {HTMLElement} */ (t.querySelector('[data-rensave]')).click();
      if (ev.key === 'Escape') loadVoiceList();
    });
    return;
  }
  if (rs) {
    const inp = /** @type {HTMLInputElement} */ (
      /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('.t')).querySelector('input')
    );
    // A rename is a rename of the IDENTITY now (§14.2), so it can be REJECTED — the label is
    // the uniqueness namespace across both tabs. The old code fired and forgot, which under
    // the new rule would have silently discarded the rename and reloaded the old name back
    // into the row with no explanation.
    try {
      const rr = await fetch('/voices/' + encodeURIComponent(rs) + '/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: inp.value.trim() }),
      }); // empty = back to the filename
      if (!rr.ok) {
        const jj = await rr.json().catch(() => ({}));
        await modal('That name is taken', esc(jj.message || jj.error || rr.statusText), [{ label: 'OK', class: 'primary', value: 1 }]);
      }
    } catch (e2) {
      await modal('Rename failed', esc(/** @type {ErrLike} */ (e2).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    loadVoiceList();
    loadVoices();
    return;
  }
  if (/** @type {HTMLElement} */ (e.target).dataset.rencancel) {
    loadVoiceList();
    return;
  }
});
// Prefill the name from the chosen file the moment you pick one — visible and editable,
// rather than a silently-optional box that fills itself in server-side (§14.2). Only when the
// box is empty or still holds a previous file's stem, so a name you typed is never clobbered.
let vAddPrefill = '';
/** @type {VEl} */ ($('vAddFile')).addEventListener('change', () => {
  const fileBox = /** @type {HTMLInputElement} */ ($('vAddFile'));
  const f = /** @type {FileList} */ (fileBox.files)[0];
  if (!f) return;
  const stem = f.name.replace(/\.[^.]+$/, '');
  const nameBox = /** @type {HTMLInputElement} */ ($('vAddName'));
  if (!nameBox.value.trim() || nameBox.value.trim() === vAddPrefill) nameBox.value = stem;
  vAddPrefill = stem;
});
/** @type {VEl} */ ($('vAddBtn')).onclick = async () => {
  const fileBox = /** @type {HTMLInputElement} */ ($('vAddFile'));
  const f = /** @type {FileList} */ (fileBox.files)[0];
  if (!f) {
    await modal('No file', 'Choose an audio file first.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  const name = /** @type {HTMLInputElement} */ ($('vAddName')).value.trim();
  if (!name) {
    await modal('Name it', 'Give the voice a name — it’s how you’ll find it in every picker.', [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    /** @type {VEl} */ ($('vAddName')).focus();
    return;
  }
  /** @type {HTMLButtonElement} */ ($('vAddBtn')).disabled = true;
  /** @type {VEl} */ ($('vAddBtn')).textContent = 'Uploading…';
  try {
    const fd = new FormData();
    fd.append('file', f);
    fd.append('name', name);
    const r = await fetch('/voices', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    // 🔴 A collision is REJECTED, never overwritten (§14.9.1). To replace a voice you delete
    // it first — so there is no Overwrite button here or anywhere else.
    if (r.status === 409) {
      await modal('That name is taken', esc(j.message || 'A voice already has that name.'), [{ label: 'OK', class: 'primary', value: 1 }]);
      /** @type {VEl} */ ($('vAddName')).focus();
      /** @type {HTMLInputElement} */ ($('vAddName')).select();
      return;
    }
    if (!r.ok) throw new Error(j.error || r.statusText);
    await modal(
      'Voice added',
      `<b>${esc(j.label || j.name)}</b> saved (peak ${j.peak_dbfs != null ? j.peak_dbfs.toFixed(1) + ' dBFS' : 'normalized'}).`,
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
    /** @type {HTMLInputElement} */ ($('vAddFile')).value = '';
    /** @type {HTMLInputElement} */ ($('vAddName')).value = '';
    vAddPrefill = '';
    loadVoiceList();
    loadVoices();
  } catch (e) {
    await modal('Upload failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    /** @type {HTMLButtonElement} */ ($('vAddBtn')).disabled = false;
    /** @type {VEl} */ ($('vAddBtn')).textContent = 'Upload';
  }
};
// Enter in the name or file field uploads — the Add-a-voice row isn't a <form>, so wire it
// explicitly. Ignored while a repeat keydown fires and while the button is mid-upload (a
// disabled .click() is a no-op), so Enter can't double-submit.
['vAddName', 'vAddFile'].forEach(id =>
  /** @type {VEl} */ ($(id)).addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.repeat) {
      e.preventDefault();
      /** @type {VEl} */ ($('vAddBtn')).click();
    }
  }),
);

// ── Create a voice (4.8-m2): VoxCPM2 design → audition → freeze ───────────
// The Create tab appears only when /health says VoxCPM2 is installed. Save runs the cleanup
// chain and freezes a candidate into the shared Voices list (server-side) — after which it's
// an ordinary voice everywhere.
// `vcTab` itself is declared up in the Voices-management block — renderVoiceList needs it.
//
// ⚠️ `vc` LIVES IN js/voice/design.js (7.3-m8a) AND IS IMPORTED AT THE TOP OF THIS FILE. THREE
// things share it — this design form, the candidate QUEUE (js/voice/candidates.js) and the overnight
// BATCH (js/voice/batch.js) — which is why it is its own file rather than traveling with any one of
// them; declaring it here while importing from the other two would be a cycle. 📌 The four sites
// below were the last ones reading it off the `Object.assign` shim, so m8a's own note — *"that shim
// line is expected to be DELETED at m8b"* — is discharged in this commit.
//
// ⚠️ THIS PARAGRAPH IS THE ONE NON-VERBATIM CHANGE IN THE MOVE. It was m8a's pointer comment, left
// where `vc` had been, and every sentence of it was written about the PAGE — "the form's four sites
// here read it off the shim" stops being true in the same commit that moves the form.
// ── Language (4.8-m4) ────────────────────────────────────────────────────
// 🔴 VoxCPM2 has NO language parameter. Its model card: "30-Language Multilingual — No language
// tag needed; input text in any supported language directly", and _generate() takes only
// text/prompt/cfg/timesteps/len/normalize/denoise/retry/seed. The language of the designed voice
// is simply the language of the SAMPLE TEXT. So picking a language here swaps the sample, and
// the accent phrase in the description — which matters, because the English default asks for "a
// Midwestern American accent" and that fights a Spanish sample instead of describing it.
//
// The DESCRIPTION stays in English on purpose. English quality-descriptors are the recipe m0's
// ear-tests settled on (§4.2: positive quality words work, negatives/effects backfire); the
// description is soft conditioning read by the model, not words anyone speaks. Only the accent
// clause varies. English's entry reproduces today's tuned default string byte-for-byte.
/** @param {string} a */
const VC_DESC = a => `a 20-year-old woman with ${a}, warm and clear, studio-quality recording, close to the microphone`;
// ── Length (4.8-m4d) ────────────────────────────────────────────────────
// Each language carries its sample as THREE CUMULATIVE PARTS, not three separate passages:
// "30 s" is parts 1–2 joined, "60 s" is all three. Two reasons, both practical. Extending what
// you are already reading is legible — reaching for a longer sample keeps the opening you just
// auditioned instead of swapping in an unrelated wall of text. And it is a third fewer words to
// author and proof-read across 30 languages, so a wobbly translation cannot disagree with
// ITSELF between two lengths.
//
// 🔴 The sizes are based on timed VoxCPM2 runs (cfg 2.0 / 30 steps / seed 7). The rate is NOT
// constant — a short passage carries
// proportionally more silence and pause, so it runs ~3.5 w/s where the long ones run ~4.1–4.5,
// and one rate left "30 s" and "60 s" about 20% short of their own labels.
//
// 🔴 THE LABELS ARE APPROXIMATE, AND THAT IS THE DRAW, NOT THE SIZING. Repeat runs of similar
// text can vary by several seconds — VoxCPM2's pace wanders between draws,
// which is precisely why the control says "Approximate length" and why chasing the last two
// seconds is not worth re-authoring 30 languages over. The 36-word part reproduced 10.40 s to
// the centisecond across BOTH runs, so the instrument is sound; it is the model that varies.
//
// Do not size a final passage by extrapolating a rate; re-sizing these means TIMING them again.
// Non-Latin scripts are sized in
// PROPORTION to their own 10 s part; only English has been on a stopwatch, and a word count
// means nothing in Chinese or Thai anyway.
//
// 🔴 The 10 s English part is the m0-tuned default with two clauses moved into part 2, NOT a
// rewrite — same voice, same emotional arc, ~36 words instead of 45. The old 45-word string
// measured ~12–15 s, so shipping it under a "10 s" label would have been the one thing this
// card refuses to do: quietly misname a control.
//
// 🔴 CONTRACTIONS KEEP THE SPOKEN SAMPLE CONVERSATIONAL. Parts 2 and 3 had "we will get there"
// sitting one clause after "we'll take it", and
// "it will be worth" — VoxCPM2 reads what you write, so an uncontracted auxiliary comes out
// stilted and the voice stops sounding like a person. Every "we will / it will / we have" that
// a native speaker would contract now is contracted. Keep it that way when editing: this is
// SPOKEN text, and the register is part of what the sample is demonstrating.
// This is an ENGLISH rule and it has only been applied to English. Contraction in this sense
// has no equivalent in most of the other 29; the nearest analog is French dropping the "ne"
// of "je ne sais pas", and that is a register gamble nobody here can ear-test, so the French
// sample keeps its written "ne". Do not "fix" the other languages by analogy.
// The 30 the model card lists, alphabetical, English first as the default.
/**
 * [language name, accent clause for `VC_DESC`, three CUMULATIVE sample-text parts]. Pinned as a
 * tuple array rather than left inferred: inference over 30 mixed `[string,string,string[]]`
 * entries widens to `(string|string[])[][]`, which loses `string[]` on the third slot and breaks
 * `vcSampleFor`'s `.join()` on it.
 * @type {Array<[string, string, string[]]>}
 */
const VC_LANGS = [
  [
    'English',
    'a Midwestern American accent',
    [
      "Oh, hi! It's so good to see you. Honestly, I've been having kind of a rough day. But seeing you here, right now, it just turned everything around. I promise, this is going to be wonderful.",
      "Come on, let's do this together. There are mornings when everything feels heavy, when I'm tired and part of me just wants to stay in bed. But then I remember why I started all of this, and something lights up again. And oh, it's exciting! Genuinely, this is thrilling. So tell me — are you ready? Because I've got a feeling about this, and I really do mean it. I keep thinking about how far we've already come, and honestly, it still surprises me every time. Look at what the two of us managed to build together.",
      "Let's take a slow, deep breath together, and then let's begin. I want to tell you something, and I mean it: thank you. Truly. That means more to me than you could possibly know. People ask me how I keep going, and the honest answer is that I don't always. Some days I sit down and nothing comes at all. But the quiet days matter too, I think. They teach you patience. So we'll take it one small step at a time, and we'll get there. I promise you, it'll be worth every single minute. And when we finally get there, I want you to remember this exact moment, right here at the very start.",
    ],
  ],
  [
    'Arabic',
    'a neutral Modern Standard Arabic accent',
    [
      'أهلاً! سعيدة جداً برؤيتك. بصراحة، كان يومي متعباً بعض الشيء. لكن وجودك هنا الآن غيّر كل شيء. أعدك، سيكون شيئاً رائعاً.',
      'هيا بنا، لنفعل هذا معاً. هناك صباحات يبدو فيها كل شيء ثقيلاً، أشعر بالتعب وجزء مني يريد أن يبقى في السرير. لكنني أتذكر لماذا بدأت كل هذا، فيضيء شيء بداخلي من جديد. وآه، كم هذا مثير! حقاً، إنه أمر يبعث على الحماس. قل لي، هل أنت مستعد؟ لأن لدي شعوراً جميلاً حيال هذا، وأنا أعني ما أقول. وأنا أفكر دائماً كم قطعنا من طريق حتى الآن، وبصراحة، ما زال ذلك يدهشني في كل مرة. انظر إلى ما استطعنا أن نبنيه معاً.',
      'لنأخذ نفساً عميقاً وهادئاً معاً، ثم لنبدأ. أريد أن أقول لك شيئاً وأنا صادقة تماماً: شكراً لك. حقاً. هذا يعني لي أكثر مما تتصور. يسألني الناس كيف أستمر، والجواب الصادق أنني لا أستمر دائماً. في بعض الأيام أجلس ولا يأتيني شيء على الإطلاق. لكن الأيام الهادئة مهمة أيضاً، على ما أظن. إنها تعلمنا الصبر. لذلك سنمضي خطوة صغيرة تلو الأخرى، وسنصل. أعدك، سيستحق الأمر كل دقيقة. وحين نصل أخيراً، أريدك أن تتذكر هذه اللحظة بالذات، هنا تماماً في البداية.',
    ],
  ],
  [
    'Burmese',
    'a neutral Burmese accent',
    [
      'ဟိုင်း! မင်းကိုတွေ့ရတာ တကယ်ဝမ်းသာတယ်။ တကယ်တော့ ဒီနေ့ နည်းနည်းပင်ပန်းခဲ့တယ်။ ဒါပေမယ့် မင်းကိုတွေ့လိုက်တာနဲ့ အားလုံးပြောင်းသွားပြီ။ ကတိပေးတယ်၊ အရမ်းကောင်းမှာပါ။',
      'လာပါ၊ အတူတူလုပ်ကြရအောင်။ တစ်ခါတစ်ရံ မနက်ခင်းတွေမှာ အရာအားလုံးက လေးလံနေသလိုပဲ၊ ပင်ပန်းပြီး အိပ်ရာထဲမှာပဲ ဆက်နေချင်တယ်။ ဒါပေမယ့် ဘာကြောင့် ဒါတွေစခဲ့လဲဆိုတာ ပြန်သတိရတဲ့အခါ တစ်ခုခုက ပြန်လင်းလာတယ်။ အိုး၊ တကယ်စိတ်လှုပ်ရှားစရာကောင်းတယ်။ ပြောပြပါဦး၊ အဆင်သင့်ဖြစ်ပြီလား။ ဒါက ကောင်းမယ်လို့ ခံစားရလို့ပါ။ ငါတို့ ဘယ်လောက်အထိ ရောက်လာပြီးပြီဆိုတာ အမြဲတွေးမိတယ်၊ တကယ်ပြောရရင် အခုထိ အံ့ဩနေတုန်းပဲ။ ငါတို့နှစ်ယောက် အတူတူ တည်ဆောက်နိုင်ခဲ့တာတွေကို ကြည့်လိုက်ပါဦး။',
      'အတူတူ အသက်ကို ဖြည်းဖြည်းချင်း ရှူလိုက်ကြရအောင်၊ ပြီးရင် စကြမယ်။ တစ်ခုပြောချင်တယ်၊ တကယ်ပြောတာပါ။ ကျေးဇူးတင်ပါတယ်။ တကယ်ပါ။ မင်းထင်ထားတာထက် ပိုအဓိပ္ပာယ်ရှိပါတယ်။ ဘယ်လိုဆက်လုပ်နိုင်တာလဲလို့ လူတွေမေးကြတယ်။ ဟုတ်တိုင်းဖြောင့်ပြောရရင် အမြဲတမ်းတော့ မဟုတ်ပါဘူး။ တစ်ချို့ရက်တွေမှာ ထိုင်လိုက်ပေမယ့် ဘာမှမပေါ်လာဘူး။ ဒါပေမယ့် တိတ်ဆိတ်တဲ့နေ့တွေလည်း အရေးကြီးတယ်လို့ ထင်တယ်။ သည်းခံတတ်အောင် သင်ပေးတယ်။ ဒါကြောင့် တစ်ဆင့်ချင်း ဖြည်းဖြည်းသွားကြမယ်၊ ရောက်မှာပါ။ ကတိပေးတယ်၊ မိနစ်တိုင်း တန်ဖိုးရှိပါလိမ့်မယ်။ နောက်ဆုံး ရောက်တဲ့အခါ ဒီအစပိုင်းက ဒီအခိုက်အတန့်ကို မင်းမှတ်မိနေစေချင်တယ်။',
    ],
  ],
  [
    'Chinese',
    'a neutral Mandarin Chinese accent',
    [
      '嗨！见到你真好。说实话，我今天过得有点累。可是看到你在这里，一切都不一样了。我保证，一定会很棒的。',
      '来吧，我们一起来做这件事。有些早晨，什么都觉得沉重，人很疲惫，只想赖在床上。可是一想起当初为什么开始，心里又亮了起来。啊，真让人兴奋！说真的，这太让人期待了。告诉我，你准备好了吗？因为我有一种预感，而且我是认真的。我常常想起我们已经走了这么远，说真的，每次想到都还是觉得不可思议。你看看我们两个一起做出来的这些。',
      '我们一起慢慢地深吸一口气，然后开始吧。我想告诉你一件事，我是真心的：谢谢你。真的。这对我的意义比你想象的还要大。常常有人问我，是怎么坚持下来的。老实说，我并不是一直都能坚持。有些日子坐下来，脑子里一片空白。可是我觉得，安静的日子也有它的意义，它教会人耐心。所以我们就一步一步慢慢来，总会到的。我向你保证，这一切都值得。等我们真的走到那一天，我希望你还记得此刻，就在这个开始的地方。',
    ],
  ],
  [
    'Danish',
    'a neutral Danish accent',
    [
      'Hej! Hvor er det godt at se dig. Helt ærligt, jeg har haft en lidt hård dag. Men at se dig her lige nu vendte det hele. Det bliver skønt, det lover jeg.',
      'Kom, lad os gøre det sammen. Der er morgener, hvor alt føles tungt, hvor jeg er træt, og en del af mig bare vil blive i sengen. Men så husker jeg, hvorfor jeg begyndte på det hele, og så lyser noget op igen. Og åh, hvor er det spændende! Helt ærligt, det er vildt. Så sig mig — er du klar? For jeg har en god fornemmelse med det her, og det mener jeg. Jeg tænker tit på, hvor langt vi allerede er kommet, og helt ærligt overrasker det mig stadig hver gang. Se lige, hvad vi to har fået bygget sammen.',
      'Lad os tage en langsom, dyb indånding sammen, og så begynder vi. Der er noget, jeg gerne vil sige, og jeg mener det: tak. Virkelig. Det betyder mere for mig, end du aner. Folk spørger, hvordan jeg bliver ved, og det ærlige svar er, at det gør jeg ikke altid. Nogle dage sætter jeg mig ned, og der kommer ingenting. Men de stille dage betyder også noget, tror jeg. De lærer en tålmodighed. Så vi tager det et lille skridt ad gangen, og vi når frem. Det bliver hvert eneste minut værd, det lover jeg dig. Og når vi endelig når frem, vil jeg gerne have, at du husker præcis dette øjeblik, lige her ved begyndelsen.',
    ],
  ],
  [
    'Dutch',
    'a neutral Dutch accent',
    [
      'Hé, hallo! Wat fijn om je te zien. Eerlijk gezegd had ik een zware dag. Maar nu jij hier bent, is alles anders. Het wordt prachtig, dat beloof ik.',
      'Kom op, laten we het samen doen. Er zijn ochtenden waarop alles zwaar voelt, waarop ik moe ben en een deel van mij gewoon in bed wil blijven. Maar dan bedenk ik waarom ik hieraan begonnen ben, en gaat er weer iets branden. En o, wat is dit spannend! Echt waar, ik kijk er enorm naar uit. Vertel eens — ben je er klaar voor? Want ik heb er een goed gevoel over, en dat meen ik. Ik denk vaak aan hoe ver we al gekomen zijn, en eerlijk gezegd verbaast het me nog elke keer. Kijk nou toch wat wij tweeën samen hebben opgebouwd.',
      'Laten we samen rustig diep ademhalen, en dan beginnen we. Ik wil je iets zeggen, en ik meen het echt: dank je wel. Oprecht. Dat betekent meer voor me dan je je kunt voorstellen. Mensen vragen me hoe ik het volhoud, en het eerlijke antwoord is dat dat niet altijd lukt. Sommige dagen ga ik zitten en komt er helemaal niets. Maar de stille dagen tellen ook, denk ik. Ze leren je geduld. Dus we doen het stap voor stap, en we komen er wel. Ik beloof je, het is elke minuut waard. En als we er eindelijk zijn, wil ik dat je je precies dit moment herinnert, hier helemaal aan het begin.',
    ],
  ],
  [
    'Finnish',
    'a neutral Finnish accent',
    [
      'Hei! Onpa ihanaa nähdä sinua. Rehellisesti sanottuna päiväni on ollut aika raskas. Mutta kun näen sinut tässä, kaikki kääntyi parhain päin. Lupaan, että tästä tulee upeaa.',
      'Tule, tehdään tämä yhdessä. On aamuja, jolloin kaikki tuntuu raskaalta, jolloin olen väsynyt ja osa minusta haluaisi vain jäädä sänkyyn. Mutta sitten muistan, miksi aloitin kaiken tämän, ja jokin syttyy taas. Ja voi, miten jännittävää! Ihan oikeasti, tämä on huikeaa. Kerro — oletko valmis? Minulla nimittäin on tästä hyvä tunne, ja tarkoitan sitä. Ajattelen usein, miten pitkälle olemme jo tulleet, ja rehellisesti sanottuna se yllättää minut joka kerta. Katso, mitä me kaksi olemme saaneet yhdessä aikaan.',
      'Vedetään yhdessä hitaasti syvään henkeä, ja sitten aloitetaan. Haluan sanoa sinulle jotain, ja tarkoitan sitä: kiitos. Ihan oikeasti. Se merkitsee minulle enemmän kuin arvaatkaan. Ihmiset kysyvät, miten jaksan, ja rehellinen vastaus on, etten aina jaksakaan. Joinakin päivinä istun alas eikä mitään tule. Mutta hiljaiset päivät ovat minusta tärkeitä nekin. Ne opettavat kärsivällisyyttä. Otetaan siis yksi pieni askel kerrallaan, kyllä me perille päästään. Lupaan sinulle, että se on jokaisen minuutin arvoista. Ja kun lopulta pääsemme perille, haluan sinun muistavan juuri tämän hetken, tässä aivan alussa.',
    ],
  ],
  [
    'French',
    'a neutral French accent',
    [
      "Oh, salut ! Ça fait tellement plaisir de te voir. Honnêtement, j'ai eu une journée un peu difficile. Mais te voir ici, maintenant, ça a tout changé. Je te promets que ce sera merveilleux.",
      "Allez, viens, on va le faire ensemble. Il y a des matins où tout paraît lourd, où je suis fatiguée et où une partie de moi voudrait juste rester au lit. Et puis je me rappelle pourquoi j'ai commencé tout ça, et quelque chose se rallume. Et oh, c'est excitant ! Vraiment, c'est grisant. Alors dis-moi — tu es prêt ? Parce que j'ai un bon pressentiment, et je le pense sincèrement. Je pense souvent au chemin qu'on a déjà parcouru, et franchement, ça m'étonne encore à chaque fois. Regarde un peu ce qu'on a réussi à construire tous les deux.",
      "Prenons une longue inspiration, tout doucement, ensemble, et puis commençons. Je veux te dire quelque chose, et je le pense vraiment : merci. Sincèrement. Ça compte plus pour moi que tu ne peux l'imaginer. On me demande comment je tiens, et la réponse honnête, c'est que je ne tiens pas toujours. Certains jours, je m'assois et rien ne vient. Mais les jours calmes comptent aussi, je crois. Ils apprennent la patience. Alors on avancera un petit pas à la fois, et on y arrivera. Je te le promets, ça vaudra chaque minute. Et quand on y sera enfin, je veux que tu te souviennes exactement de cet instant, ici, tout au début.",
    ],
  ],
  [
    'German',
    'a neutral German accent',
    [
      'Oh, hallo! Schön, dich zu sehen. Ehrlich gesagt war mein Tag ziemlich anstrengend. Aber dich jetzt hier zu sehen, hat alles verändert. Ich verspreche dir, es wird wunderbar.',
      'Komm, lass es uns zusammen machen. Es gibt Morgen, an denen sich alles schwer anfühlt, an denen ich müde bin und ein Teil von mir einfach liegen bleiben will. Aber dann fällt mir wieder ein, warum ich damit angefangen habe, und irgendetwas leuchtet wieder auf. Und oh, ist das aufregend! Wirklich, das ist großartig. Also sag mir — bist du bereit? Ich habe nämlich ein gutes Gefühl dabei, und das meine ich ernst. Ich denke oft daran, wie weit wir schon gekommen sind, und ehrlich gesagt überrascht mich das jedes Mal aufs Neue. Sieh dir an, was wir beide zusammen aufgebaut haben.',
      'Lass uns zusammen langsam und tief durchatmen, und dann fangen wir an. Ich möchte dir etwas sagen, und ich meine es so: danke. Wirklich. Das bedeutet mir mehr, als du ahnst. Die Leute fragen mich, wie ich durchhalte, und die ehrliche Antwort ist: nicht immer. An manchen Tagen setze ich mich hin, und es kommt einfach nichts. Aber die stillen Tage zählen auch, finde ich. Sie lehren einen Geduld. Also gehen wir es Schritt für Schritt an, und wir kommen an. Ich verspreche dir, es ist jede einzelne Minute wert. Und wenn wir endlich ankommen, möchte ich, dass du dich genau an diesen Moment erinnerst, hier ganz am Anfang.',
    ],
  ],
  [
    'Greek',
    'a neutral Greek accent',
    [
      'Α, γεια σου! Χαίρομαι πολύ που σε βλέπω. Ειλικρινά, η μέρα μου ήταν λίγο δύσκολη. Αλλά που σε βλέπω εδώ τώρα, άλλαξαν όλα. Σου υπόσχομαι, θα είναι υπέροχα.',
      'Έλα, ας το κάνουμε μαζί. Υπάρχουν πρωινά που όλα μοιάζουν βαριά, που είμαι κουρασμένη και ένα κομμάτι μου θέλει απλώς να μείνει στο κρεβάτι. Και μετά θυμάμαι γιατί τα ξεκίνησα όλα αυτά, και κάτι ανάβει ξανά μέσα μου. Και αχ, τι συναρπαστικό! Αλήθεια, είναι κάτι που με ενθουσιάζει. Πες μου λοιπόν — είσαι έτοιμος; Γιατί έχω ένα πολύ καλό προαίσθημα, και το εννοώ. Σκέφτομαι συχνά πόσο δρόμο έχουμε κάνει ήδη, και ειλικρινά, ακόμη με εκπλήσσει κάθε φορά. Κοίτα τι καταφέραμε να χτίσουμε οι δυο μας μαζί.',
      'Ας πάρουμε μαζί μια αργή, βαθιά ανάσα, και ας ξεκινήσουμε. Θέλω να σου πω κάτι, και το εννοώ πραγματικά: σε ευχαριστώ. Αλήθεια. Σημαίνει για μένα περισσότερα από όσα φαντάζεσαι. Με ρωτούν πώς συνεχίζω, και η ειλικρινής απάντηση είναι ότι δεν συνεχίζω πάντα. Κάποιες μέρες κάθομαι και δεν έρχεται τίποτα. Αλλά και οι ήσυχες μέρες μετράνε, νομίζω. Σου μαθαίνουν υπομονή. Θα το πάμε λοιπόν ένα μικρό βήμα τη φορά, και θα φτάσουμε. Σου το υπόσχομαι, θα αξίζει το κάθε λεπτό. Και όταν φτάσουμε επιτέλους, θέλω να θυμάσαι ακριβώς αυτή τη στιγμή, εδώ, στην αρχή.',
    ],
  ],
  [
    'Hebrew',
    'a neutral Hebrew accent',
    [
      'היי! כל כך טוב לראות אותך. האמת, היה לי יום די קשה. אבל לראות אותך כאן עכשיו שינה הכול. אני מבטיחה, זה הולך להיות נפלא.',
      'בוא, נעשה את זה יחד. יש בקרים שהכול מרגיש כבד, שאני עייפה וחלק ממני פשוט רוצה להישאר במיטה. אבל אז אני נזכרת למה התחלתי את כל זה, ומשהו נדלק בי מחדש. ואוו, כמה שזה מרגש! באמת, זה ממש מלהיב. אז תגיד לי — אתה מוכן? כי יש לי הרגשה טובה לגבי זה, ואני מתכוונת לכל מילה. אני חושבת הרבה על כמה רחוק כבר הגענו, ובאמת, זה עדיין מפתיע אותי בכל פעם. תראה מה ששנינו הצלחנו לבנות יחד.',
      'בוא ניקח יחד נשימה עמוקה ואיטית, ואז נתחיל. אני רוצה להגיד לך משהו, ואני מתכוונת לזה: תודה. באמת. זה אומר לי יותר ממה שאתה יכול לתאר. שואלים אותי איך אני ממשיכה, והתשובה הכנה היא שלא תמיד. יש ימים שאני מתיישבת ופשוט לא בא כלום. אבל גם הימים השקטים חשובים, אני חושבת. הם מלמדים סבלנות. אז נלך צעד קטן אחד בכל פעם, ונגיע. אני מבטיחה לך, זה יהיה שווה כל דקה. וכשנגיע סוף סוף, אני רוצה שתזכור בדיוק את הרגע הזה, כאן, ממש בהתחלה.',
    ],
  ],
  [
    'Hindi',
    'a neutral Hindi accent',
    [
      'अरे, नमस्ते! तुम्हें देखकर बहुत अच्छा लगा। सच कहूँ तो आज का दिन थोड़ा मुश्किल था। लेकिन तुम्हें यहाँ देखकर सब कुछ बदल गया। मैं वादा करती हूँ, यह बहुत शानदार होगा।',
      'चलो, इसे साथ मिलकर करते हैं। कुछ सुबहें ऐसी होती हैं जब सब कुछ भारी लगता है, जब मैं थकी होती हूँ और मन करता है बस बिस्तर में ही पड़ी रहूँ। लेकिन फिर याद आता है कि मैंने यह सब शुरू ही क्यों किया था, और भीतर कुछ फिर से जल उठता है। और अरे, कितना रोमांचक है यह! सच में, बहुत मज़ा आने वाला है। बताओ, तुम तैयार हो? क्योंकि मुझे इसका बहुत अच्छा एहसास हो रहा है। मैं अक्सर सोचती हूँ कि हम अब तक कितनी दूर आ चुके हैं, और सच कहूँ तो हर बार यह मुझे हैरान कर देता है। देखो न, हम दोनों ने मिलकर क्या बना डाला।',
      'चलो, साथ में एक गहरी और धीमी साँस लेते हैं, और फिर शुरू करते हैं। मैं तुमसे कुछ कहना चाहती हूँ, और सच में कहना चाहती हूँ: शुक्रिया। सच में। यह मेरे लिए उससे कहीं ज़्यादा मायने रखता है जितना तुम सोच सकते हो। लोग पूछते हैं कि मैं कैसे चलती रहती हूँ, और ईमानदारी से कहूँ तो हमेशा नहीं चल पाती। कुछ दिन ऐसे होते हैं जब मैं बैठती हूँ और कुछ भी नहीं आता। लेकिन शांत दिन भी ज़रूरी होते हैं, मुझे लगता है। वे सब्र सिखाते हैं। तो हम एक-एक छोटा कदम बढ़ाएँगे, और पहुँच ही जाएँगे। मैं वादा करती हूँ, यह हर एक पल के लायक होगा। और जब हम आख़िरकार वहाँ पहुँचेंगे, तो मैं चाहती हूँ कि तुम्हें ठीक यही पल याद रहे, यहीं, बिलकुल शुरुआत में।',
    ],
  ],
  [
    'Indonesian',
    'a neutral Indonesian accent',
    [
      'Hai! Senang sekali bertemu denganmu. Sejujurnya, hariku agak berat. Tapi melihatmu di sini sekarang, semuanya berubah. Aku janji, ini akan luar biasa.',
      'Ayo, kita lakukan ini bersama. Ada pagi-pagi ketika semuanya terasa berat, ketika aku lelah dan sebagian diriku hanya ingin tetap di tempat tidur. Tapi kemudian aku ingat kenapa aku memulai semua ini, dan ada sesuatu yang menyala lagi. Dan oh, ini seru sekali! Sungguh, ini menegangkan. Jadi katakan padaku — kamu siap? Karena aku punya firasat baik soal ini, dan aku serius. Aku sering memikirkan sudah sejauh apa kita melangkah, dan sejujurnya, itu masih membuatku takjub setiap kali. Lihat apa yang berhasil kita bangun berdua.',
      'Mari kita tarik napas dalam-dalam pelan-pelan bersama, lalu kita mulai. Ada yang ingin kukatakan, dan aku sungguh-sungguh: terima kasih. Sungguh. Itu berarti lebih banyak bagiku daripada yang bisa kamu bayangkan. Orang bertanya bagaimana aku bisa terus bertahan, dan jawaban jujurnya adalah aku tidak selalu bisa. Ada hari-hari ketika aku duduk dan tidak ada apa pun yang datang. Tapi hari-hari yang sepi juga penting, menurutku. Hari-hari itu mengajarkan kesabaran. Jadi kita akan melangkah sedikit demi sedikit, dan kita pasti sampai. Aku janji, ini akan sepadan dengan setiap menitnya. Dan ketika kita akhirnya sampai, aku ingin kamu mengingat momen ini, tepat di sini, di awal segalanya.',
    ],
  ],
  [
    'Italian',
    'a neutral Italian accent',
    [
      "Oh, ciao! Che bello vederti. Sinceramente, ho avuto una giornata un po' difficile. Ma vederti qui, adesso, ha cambiato tutto. Te lo prometto, sarà meraviglioso.",
      "Dai, facciamolo insieme. Ci sono mattine in cui tutto sembra pesante, in cui sono stanca e una parte di me vorrebbe solo restare a letto. Poi però mi ricordo perché ho cominciato tutto questo, e qualcosa si riaccende. E oh, che emozione! Davvero, è entusiasmante. Allora dimmi — sei pronto? Perché ho una bella sensazione, e lo dico sul serio. Penso spesso a quanta strada abbiamo già fatto, e sinceramente mi sorprende ancora ogni volta. Guarda un po' che cosa siamo riusciti a costruire noi due insieme.",
      "Facciamo insieme un respiro lento e profondo, e poi cominciamo. Voglio dirti una cosa, e la penso davvero: grazie. Sul serio. Significa per me più di quanto tu possa immaginare. Mi chiedono come faccio ad andare avanti, e la risposta onesta è che non sempre ci riesco. Certi giorni mi siedo e non arriva niente. Ma anche i giorni silenziosi contano, credo. Insegnano la pazienza. Quindi andremo avanti un passo alla volta, e ci arriveremo. Te lo prometto, varrà ogni singolo minuto. E quando finalmente ci arriveremo, voglio che tu ricordi esattamente questo momento, qui, proprio all'inizio.",
    ],
  ],
  [
    'Japanese',
    'a neutral Japanese accent',
    [
      'あ、こんにちは！会えて本当にうれしいです。正直に言うと、今日はちょっと大変な一日でした。でも、今ここであなたに会えて、すべてが変わりました。きっと素晴らしいものになりますよ。',
      'さあ、一緒にやりましょう。朝、何もかもが重く感じて、疲れていて、ただベッドにいたいと思う日もあります。でも、どうしてこれを始めたのかを思い出すと、また心に明かりがつくんです。ああ、わくわくしますね！本当に、これはたまりません。ねえ、準備はいいですか。なんだかいい予感がするんです。ここまで来られたことを、よく思い返すんです。正直に言うと、思い出すたびに今でも驚いてしまいます。ふたりで作り上げてきたものを、ちょっと見てくださいよ。',
      'ゆっくり深く息を吸って、それから始めましょう。ひとつだけ言わせてください。本気で言っています。ありがとう。本当に。あなたが思っている以上に、私にとって大きな意味があるんです。どうして続けられるのかとよく聞かれますが、正直に言えば、いつも続けられるわけではありません。座っても何も出てこない日だってあります。でも、静かな日にも意味があると思うんです。忍耐を教えてくれますから。だから、小さな一歩ずつ進んでいきましょう。きっとたどり着けます。約束します、その一分一分に必ず価値がありますから。そしていつかたどり着いたとき、この始まりの瞬間を、あなたに覚えていてほしいんです。',
    ],
  ],
  [
    'Khmer',
    'a neutral Khmer accent',
    [
      'សួស្តី! រីករាយណាស់ដែលបានជួបអ្នក។ និយាយឱ្យត្រង់ទៅ ថ្ងៃនេះខ្ញុំហត់បន្តិច។ ប៉ុន្តែការឃើញអ្នកនៅទីនេះ បានផ្លាស់ប្តូរអ្វីៗទាំងអស់។ ខ្ញុំសន្យាថា វានឹងអស្ចារ្យណាស់។',
      'មកចុះ យើងធ្វើវាជាមួយគ្នា។ មានព្រឹកខ្លះ អ្វីៗហាក់ដូចជាធ្ងន់ណាស់ ខ្ញុំអស់កម្លាំង ហើយចង់ដេកនៅលើគ្រែតែម្តង។ ប៉ុន្តែពេលខ្ញុំនឹកឃើញថាហេតុអ្វីបានជាខ្ញុំចាប់ផ្តើមរឿងទាំងអស់នេះ អ្វីមួយក៏ភ្លឺឡើងវិញ។ អូ គួរឱ្យរំភើបណាស់! ពិតជាគួរឱ្យទន្ទឹងរង់ចាំមែន។ ប្រាប់ខ្ញុំមក តើអ្នករួចរាល់ហើយឬនៅ? ព្រោះខ្ញុំមានអារម្មណ៍ល្អចំពោះរឿងនេះណាស់។ ខ្ញុំតែងតែគិតថាយើងបានឆ្លងកាត់ផ្លូវឆ្ងាយប៉ុណ្ណាហើយ ហើយនិយាយឱ្យត្រង់ទៅ វានៅតែធ្វើឱ្យខ្ញុំភ្ញាក់ផ្អើលរាល់ដង។ សូមមើលអ្វីដែលយើងទាំងពីរនាក់បានសាងសង់ជាមួយគ្នា។',
      'តោះ ដកដង្ហើមវែងៗ យឺតៗ ជាមួយគ្នា រួចយើងចាប់ផ្តើម។ ខ្ញុំចង់ប្រាប់អ្នកអ្វីមួយ ហើយខ្ញុំនិយាយពីចិត្តពិត៖ អរគុណ។ អរគុណច្រើនណាស់។ វាមានន័យសម្រាប់ខ្ញុំច្រើនជាងអ្វីដែលអ្នកគិត។ មនុស្សតែងសួរខ្ញុំថា ធ្វើម៉េចទើបបន្តបាន ហើយចម្លើយត្រង់ៗគឺ ខ្ញុំមិនអាចបន្តបានគ្រប់ពេលទេ។ ថ្ងៃខ្លះខ្ញុំអង្គុយចុះ តែគ្មានអ្វីកើតឡើងសោះ។ ប៉ុន្តែថ្ងៃស្ងាត់ៗក៏សំខាន់ដែរ ខ្ញុំគិតថា។ វាបង្រៀនយើងឱ្យចេះអត់ធ្មត់។ ដូច្នេះយើងនឹងដើរម្តងមួយជំហានតូចៗ ហើយយើងនឹងទៅដល់។ ខ្ញុំសន្យា វានឹងសក្តិសមនឹងរាល់នាទី។ ហើយពេលយើងទៅដល់ជាទីបំផុត ខ្ញុំចង់ឱ្យអ្នកចាំពេលវេលានេះឱ្យបានច្បាស់ គឺនៅទីនេះ នៅពេលចាប់ផ្តើម។',
    ],
  ],
  [
    'Korean',
    'a neutral Korean accent',
    [
      '아, 안녕하세요! 만나서 정말 반가워요. 솔직히 오늘 하루가 좀 힘들었어요. 그런데 지금 여기서 당신을 보니까 모든 게 달라졌어요. 정말 멋질 거예요, 약속할게요.',
      '자, 우리 같이 해봐요. 아침에 모든 게 무겁게 느껴지고, 너무 피곤해서 그냥 침대에 누워 있고 싶은 날도 있어요. 그런데 내가 왜 이걸 시작했는지 떠올리면, 마음속에 다시 불이 켜져요. 아, 정말 설레네요! 진짜로, 너무 기대돼요. 그래서 말인데, 준비됐어요? 왠지 느낌이 아주 좋거든요. 우리가 여기까지 왔다는 게 자주 떠올라요. 솔직히 말하면 생각할 때마다 아직도 놀라워요. 우리 둘이 함께 만들어 온 것들을 좀 보세요.',
      '우리 같이 천천히 숨을 깊게 들이쉬고, 그다음에 시작해요. 한 가지 꼭 하고 싶은 말이 있어요. 진심이에요. 고마워요. 정말로요. 당신이 생각하는 것보다 훨씬 더 큰 의미예요. 사람들이 어떻게 계속하냐고 물어보는데, 솔직히 말하면 항상 그러지는 못해요. 어떤 날은 앉아도 아무것도 떠오르지 않아요. 그래도 조용한 날들도 나름대로 의미가 있다고 생각해요. 기다리는 법을 가르쳐 주니까요. 그러니까 우리 한 걸음씩 천천히 가요. 분명히 도착할 거예요. 약속할게요, 그 모든 순간이 값질 거예요. 그리고 마침내 도착했을 때, 바로 지금 이 순간을, 이 시작점을 기억해 줬으면 좋겠어요.',
    ],
  ],
  [
    'Lao',
    'a neutral Lao accent',
    [
      'ສະບາຍດີ! ດີໃຈຫຼາຍທີ່ໄດ້ພົບເຈົ້າ. ເວົ້າຕາມຄວາມຈິງ ມື້ນີ້ຂ້ອຍເມື່ອຍໜ້ອຍໜຶ່ງ. ແຕ່ພໍໄດ້ເຫັນເຈົ້າຢູ່ນີ້ ທຸກຢ່າງກໍປ່ຽນໄປ. ຂ້ອຍສັນຍາ ມັນຈະດີຫຼາຍ.',
      'ມາເຖາະ ເຮົາມາເຮັດນຳກັນ. ມີບາງເຊົ້າທີ່ທຸກຢ່າງເບິ່ງຄືໜັກໄປໝົດ ຂ້ອຍເມື່ອຍ ແລະ ຢາກນອນຢູ່ເທິງຕຽງຕໍ່ໄປ. ແຕ່ພໍນຶກຂຶ້ນໄດ້ວ່າເປັນຫຍັງຂ້ອຍຈຶ່ງເລີ່ມສິ່ງນີ້ ບາງຢ່າງໃນໃຈກໍສະຫວ່າງຂຶ້ນອີກ. ໂອ້ ຕື່ນເຕັ້ນຫຼາຍ! ແທ້ໆ ມັນເປັນເລື່ອງທີ່ໜ້າຕື່ນເຕັ້ນ. ບອກຂ້ອຍແດ່ ເຈົ້າພ້ອມແລ້ວບໍ? ເພາະຂ້ອຍມີຄວາມຮູ້ສຶກດີກັບເລື່ອງນີ້. ຂ້ອຍມັກຄິດວ່າເຮົາມາໄກປານໃດແລ້ວ ແລະ ເວົ້າຕາມຄວາມຈິງ ມັນຍັງເຮັດໃຫ້ຂ້ອຍແປກໃຈທຸກເທື່ອ. ເບິ່ງແມ ສິ່ງທີ່ເຮົາສອງຄົນສ້າງຂຶ້ນມານຳກັນ.',
      'ມາຫາຍໃຈເລິກໆ ຊ້າໆ ນຳກັນ ແລ້ວເຮົາຄ່ອຍເລີ່ມ. ຂ້ອຍຢາກບອກເຈົ້າສິ່ງໜຶ່ງ ແລະ ຂ້ອຍເວົ້າຈາກໃຈຈິງ: ຂອບໃຈ. ຂອບໃຈຫຼາຍໆ. ມັນມີຄວາມໝາຍຕໍ່ຂ້ອຍຫຼາຍກວ່າທີ່ເຈົ້າຄິດ. ຫຼາຍຄົນຖາມວ່າຂ້ອຍເຮັດແນວໃດຈຶ່ງໄປຕໍ່ໄດ້ ຄຳຕອບທີ່ຊື່ສັດຄືຂ້ອຍບໍ່ໄດ້ໄປຕໍ່ໄດ້ຕະຫຼອດ. ບາງມື້ນັ່ງລົງແລ້ວກໍບໍ່ມີຫຍັງອອກມາເລີຍ. ແຕ່ຂ້ອຍຄິດວ່າມື້ທີ່ງຽບໆ ກໍສຳຄັນຄືກັນ. ມັນສອນໃຫ້ເຮົາອົດທົນ. ດັ່ງນັ້ນ ເຮົາຈະຄ່ອຍໆ ກ້າວໄປເທື່ອລະບາດກ້າວ ແລ້ວເຮົາຈະໄປຮອດ. ຂ້ອຍສັນຍາ ມັນຈະຄຸ້ມຄ່າທຸກໆນາທີ. ແລະ ເມື່ອເຮົາໄປຮອດແທ້ໆ ຂ້ອຍຢາກໃຫ້ເຈົ້າຈື່ຊ່ວງເວລານີ້ໄວ້ ຢູ່ບ່ອນນີ້ ຕອນເລີ່ມຕົ້ນ.',
    ],
  ],
  [
    'Malay',
    'a neutral Malay accent',
    [
      'Hai! Gembira sekali dapat berjumpa dengan awak. Sejujurnya, hari ini agak memenatkan. Tetapi melihat awak di sini sekarang mengubah segalanya. Saya janji, ia pasti indah.',
      'Marilah, kita lakukan bersama-sama. Ada pagi yang terasa berat, ketika saya letih dan sebahagian daripada diri saya hanya mahu terus berbaring. Tetapi apabila saya teringat mengapa saya memulakan semua ini, ada sesuatu yang menyala semula. Dan wah, seronoknya! Sungguh, ini amat mendebarkan. Jadi beritahu saya — awak dah bersedia? Sebab saya ada firasat yang baik tentang hal ini. Saya sering terfikir betapa jauhnya kita sudah melangkah, dan sejujurnya ia masih mengejutkan saya setiap kali. Lihatlah apa yang kita berdua berjaya bina bersama.',
      'Mari kita tarik nafas dalam-dalam perlahan-lahan bersama, kemudian kita mulakan. Ada sesuatu yang ingin saya katakan, dan saya bersungguh-sungguh: terima kasih. Sungguh. Ia bermakna lebih daripada yang awak sangkakan. Orang bertanya bagaimana saya boleh terus bertahan, dan jawapan jujurnya ialah saya tidak selalu mampu. Ada hari saya duduk dan tiada apa-apa yang datang. Tetapi hari-hari yang sunyi pun ada gunanya, pada saya. Ia mengajar kita bersabar. Jadi kita akan melangkah sedikit demi sedikit, dan kita akan sampai juga. Saya janji, ia berbaloi setiap minit. Dan apabila kita akhirnya sampai, saya mahu awak mengingati saat ini, di sini, pada permulaannya.',
    ],
  ],
  [
    'Norwegian',
    'a neutral Norwegian accent',
    [
      'Hei! Så godt å se deg. Ærlig talt har jeg hatt en litt tung dag. Men å se deg her nå snudde alt. Jeg lover, det blir helt fantastisk.',
      'Kom, la oss gjøre det sammen. Det finnes morgener der alt kjennes tungt, der jeg er sliten og en del av meg bare vil bli liggende. Men så husker jeg hvorfor jeg begynte med alt dette, og noe lyser opp igjen. Og å, så spennende det er! Helt ærlig, dette gleder jeg meg til. Så si meg — er du klar? For jeg har en veldig god følelse med dette. Jeg tenker ofte på hvor langt vi allerede har kommet, og ærlig talt overrasker det meg fortsatt hver gang. Se hva vi to har fått bygget sammen.',
      'La oss ta et langsomt, dypt pust sammen, og så begynner vi. Jeg vil si deg noe, og jeg mener det: takk. Virkelig. Det betyr mer for meg enn du aner. Folk spør hvordan jeg holder ut, og det ærlige svaret er at det gjør jeg ikke alltid. Noen dager setter jeg meg ned, og det kommer ingenting. Men de stille dagene teller også, tror jeg. De lærer deg tålmodighet. Så vi tar det ett lite skritt om gangen, og vi kommer fram. Jeg lover deg, det blir verdt hvert eneste minutt. Og når vi endelig kommer fram, vil jeg at du skal huske akkurat dette øyeblikket, her ved begynnelsen.',
    ],
  ],
  [
    'Polish',
    'a neutral Polish accent',
    [
      'O, cześć! Tak się cieszę, że cię widzę. Szczerze mówiąc, miałam dość ciężki dzień. Ale to, że jesteś tu teraz, wszystko zmieniło. Obiecuję, będzie cudownie.',
      'Chodź, zróbmy to razem. Są takie poranki, kiedy wszystko wydaje się ciężkie, kiedy jestem zmęczona i część mnie chciałaby po prostu zostać w łóżku. Ale potem przypominam sobie, po co to wszystko zaczęłam, i coś znowu się we mnie zapala. I och, jakie to ekscytujące! Naprawdę, aż mi serce mocniej bije. Powiedz mi — jesteś gotowy? Bo mam co do tego bardzo dobre przeczucie. Często myślę o tym, jak daleko już zaszliśmy, i szczerze mówiąc, za każdym razem mnie to zaskakuje. Spójrz, co udało nam się razem zbudować.',
      'Weźmy razem powolny, głęboki oddech, a potem zaczynajmy. Chcę ci coś powiedzieć i mówię to szczerze: dziękuję. Naprawdę. To znaczy dla mnie więcej, niż możesz przypuszczać. Ludzie pytają, jak to robię, że nie odpuszczam, a szczera odpowiedź brzmi: nie zawsze mi się udaje. Bywają dni, kiedy siadam i zupełnie nic nie przychodzi. Ale myślę, że te ciche dni też się liczą. Uczą cierpliwości. Więc pójdziemy krok po kroku i na pewno dojdziemy. Obiecuję ci, że będzie warto, co do minuty. A kiedy wreszcie tam dotrzemy, chcę, żebyś zapamiętał dokładnie tę chwilę, tutaj, na samym początku.',
    ],
  ],
  [
    'Portuguese',
    'a neutral Portuguese accent',
    [
      'Oi! Que bom te ver. Sinceramente, tive um dia meio difícil. Mas ver você aqui, agora, mudou tudo. Eu prometo, vai ser maravilhoso.',
      'Vem, vamos fazer isso juntos. Tem manhãs em que tudo parece pesado, em que estou cansada e uma parte de mim só quer ficar na cama. Mas aí eu lembro por que comecei tudo isso, e alguma coisa acende de novo. E ah, que emoção! Sério, isso é empolgante. Então me diz — você está pronto? Porque eu tenho um bom pressentimento, e falo isso de coração. Fico pensando no quanto a gente já caminhou, e sinceramente, isso ainda me surpreende todas as vezes. Olha só o que nós dois conseguimos construir juntos.',
      'Vamos respirar fundo bem devagar, juntos, e então começar. Quero te dizer uma coisa, e falo de verdade: obrigada. Sério mesmo. Isso significa mais para mim do que você imagina. As pessoas me perguntam como eu continuo, e a resposta honesta é que nem sempre continuo. Tem dias em que eu sento e não vem nada. Mas os dias silenciosos também contam, eu acho. Eles ensinam paciência. Então vamos passo a passo, devagarinho, e a gente chega lá. Eu te prometo, vai valer cada minuto. E quando a gente finalmente chegar lá, quero que você se lembre exatamente deste momento, aqui, bem no começo.',
    ],
  ],
  [
    'Russian',
    'a neutral Russian accent',
    [
      'О, привет! Как же я рада тебя видеть. Честно говоря, день выдался тяжёлым. Но ты здесь, и всё сразу изменилось. Обещаю, будет замечательно.',
      'Давай сделаем это вместе. Бывают утра, когда всё кажется тяжёлым, когда я устала и часть меня просто хочет остаться в постели. Но потом я вспоминаю, зачем всё это начала, и внутри снова что-то загорается. И ах, как же это волнительно! Правда, дух захватывает. Скажи мне — ты готов? Потому что у меня очень хорошее предчувствие. Я часто думаю о том, как далеко мы уже зашли, и, честно говоря, меня это до сих пор удивляет каждый раз. Ты только посмотри, что мы вдвоём сумели построить.',
      'Давай вместе сделаем медленный глубокий вдох, а потом начнём. Я хочу тебе кое-что сказать, и говорю искренне: спасибо. Правда, спасибо. Это значит для меня больше, чем ты можешь представить. Меня спрашивают, как я не бросаю, и честный ответ — иногда бросаю. Бывают дни, когда садишься, а не идёт совсем ничего. Но тихие дни, мне кажется, тоже нужны. Они учат терпению. Так что пойдём маленькими шагами, и обязательно дойдём. Обещаю тебе, это будет стоить каждой минуты. И когда мы наконец дойдём, я хочу, чтобы ты помнил именно этот момент, здесь, в самом начале.',
    ],
  ],
  [
    'Spanish',
    'a neutral Spanish accent',
    [
      '¡Ay, hola! Qué alegría verte. La verdad es que he tenido un día un poco difícil. Pero verte aquí, ahora mismo, lo ha cambiado todo. Te prometo que va a ser maravilloso.',
      'Ven, vamos a hacerlo juntos. Hay mañanas en las que todo pesa, en las que estoy cansada y una parte de mí solo quiere quedarse en la cama. Pero entonces me acuerdo de por qué empecé todo esto, y algo vuelve a encenderse. Y ay, ¡qué emocionante! De verdad, es una maravilla. Así que dime — ¿estás listo? Porque tengo muy buena sensación con esto, y lo digo en serio. Pienso mucho en lo lejos que hemos llegado ya, y sinceramente, me sigue sorprendiendo cada vez. Mira lo que hemos conseguido construir los dos juntos.',
      'Vamos a respirar hondo, despacito, juntos, y luego empezamos. Quiero decirte una cosa, y lo digo de corazón: gracias. De verdad. Significa para mí más de lo que te imaginas. La gente me pregunta cómo sigo adelante, y la respuesta honesta es que no siempre sigo. Hay días en los que me siento y no sale nada. Pero los días tranquilos también cuentan, creo yo. Enseñan paciencia. Así que iremos paso a pasito, y llegaremos. Te lo prometo, va a merecer la pena cada minuto. Y cuando por fin lleguemos, quiero que recuerdes exactamente este momento, aquí, justo al principio.',
    ],
  ],
  [
    'Swahili',
    'a neutral Swahili accent',
    [
      'Habari! Nimefurahi sana kukuona. Kwa kweli, leo imekuwa siku ngumu kidogo. Lakini kukuona hapa sasa kumebadilisha kila kitu. Nakuahidi, itakuwa nzuri sana.',
      'Njoo, tufanye hili pamoja. Kuna asubuhi ambazo kila kitu kinaonekana kizito, ninachoka na sehemu yangu inataka tu kubaki kitandani. Lakini kisha nakumbuka kwa nini nilianza yote haya, na kitu ndani yangu kinawaka tena. Na aa, inafurahisha kweli! Kusema kweli, jambo hili linanitia moyo sana. Basi niambie — uko tayari? Kwa sababu nina hisia nzuri kuhusu hili. Mara nyingi nafikiria tumefika mbali kiasi gani, na kwa kweli bado inanishangaza kila mara. Angalia tulichoweza kujenga sisi wawili pamoja.',
      'Tuvute pumzi ndefu polepole pamoja, kisha tuanze. Nataka kukuambia jambo moja, na ninasema kwa dhati: asante. Kweli kabisa. Inamaanisha kwangu zaidi kuliko unavyoweza kufikiria. Watu huniuliza ninawezaje kuendelea, na jibu la kweli ni kwamba siendelei kila wakati. Kuna siku ninaketi na hakuna kinachokuja hata kidogo. Lakini nadhani siku za kimya nazo ni muhimu. Zinatufundisha subira. Kwa hiyo tutasonga hatua ndogo moja baada ya nyingine, na tutafika. Nakuahidi, itastahili kila dakika. Na tutakapofika hatimaye, nataka ukumbuke wakati huu hasa, hapa, mwanzoni kabisa.',
    ],
  ],
  [
    'Swedish',
    'a neutral Swedish accent',
    [
      'Åh, hej! Vad skönt att se dig. Ärligt talat har jag haft en ganska tung dag. Men att se dig här nu vände allt. Jag lovar, det kommer att bli underbart.',
      'Kom, vi gör det tillsammans. Det finns morgnar när allt känns tungt, när jag är trött och en del av mig bara vill stanna kvar i sängen. Men sedan kommer jag ihåg varför jag började med allt det här, och något tänds igen. Och åh, vad spännande det är! Ärligt talat, det här ser jag verkligen fram emot. Så säg mig — är du redo? För jag har en riktigt bra känsla för det här. Jag tänker ofta på hur långt vi redan har kommit, och ärligt talat överraskar det mig fortfarande varje gång. Se på vad vi två har lyckats bygga tillsammans.',
      'Låt oss ta ett långsamt, djupt andetag tillsammans, och sedan börjar vi. Jag vill säga dig en sak, och jag menar det: tack. Verkligen. Det betyder mer för mig än du anar. Folk frågar hur jag orkar, och det ärliga svaret är att det gör jag inte alltid. Vissa dagar sätter jag mig ner och det kommer ingenting alls. Men de tysta dagarna räknas också, tror jag. De lär en tålamod. Så vi tar det ett litet steg i taget, och vi kommer fram. Jag lovar dig, det kommer att vara värt varenda minut. Och när vi äntligen är framme vill jag att du minns precis det här ögonblicket, här i början.',
    ],
  ],
  [
    'Tagalog',
    'a neutral Tagalog accent',
    [
      'Uy, kumusta! Ang saya kong makita ka. Sa totoo lang, medyo mabigat ang araw ko. Pero nang makita kita rito, nagbago ang lahat. Pangako, magiging maganda ito.',
      'Halika, gawin natin ito nang sabay. May mga umagang parang ang bigat-bigat ng lahat, pagod ako at gusto ko na lang manatili sa kama. Pero pag naalala ko kung bakit ko sinimulan ang lahat ng ito, may muling nagliliwanag sa loob ko. At naku, ang sarap sa pakiramdam! Talagang nakakakilig ito. Kaya sabihin mo nga sa akin — handa ka na ba? Kasi may magandang kutob ako rito. Madalas kong naiisip kung gaano na kalayo ang narating natin, at sa totoo lang, nakakagulat pa rin ito sa akin sa tuwina. Tingnan mo ang naitayo nating dalawa nang sabay.',
      'Huminga tayo nang malalim at dahan-dahan, tapos simulan na natin. May gusto akong sabihin sa iyo, at totoo ito: salamat. Talaga. Mas malaki ang kahulugan nito sa akin kaysa sa inaakala mo. Tinatanong ako ng mga tao kung paano ako nagpapatuloy, at ang totoo, hindi naman palagi. May mga araw na uupo ako at wala talagang lumalabas. Pero mahalaga rin ang mga tahimik na araw, sa palagay ko. Tinuturuan tayo ng pasensya. Kaya isang maliit na hakbang muna, at makakarating din tayo. Pangako sa iyo, sulit ang bawat minuto. At kapag nakarating na tayo, gusto kong maalala mo ang mismong sandaling ito, dito, sa pinakasimula.',
    ],
  ],
  [
    'Thai',
    'a neutral Thai accent',
    [
      'โอ๊ะ สวัสดี! ดีใจจังที่ได้เจอคุณ พูดตามตรงนะ วันนี้เหนื่อยนิดหน่อย แต่พอได้เห็นคุณตอนนี้ ทุกอย่างก็เปลี่ยนไปเลย ฉันสัญญาว่ามันจะดีมากแน่นอน',
      'มาเถอะ เรามาทำด้วยกัน มีบางเช้าที่ทุกอย่างรู้สึกหนักไปหมด เหนื่อยจนอยากนอนอยู่บนเตียงต่อ แต่พอนึกขึ้นได้ว่าทำไมถึงเริ่มทำสิ่งนี้ ข้างในก็สว่างขึ้นมาอีกครั้ง แล้วก็ โอ๊ย ตื่นเต้นจริง ๆ บอกตามตรงว่าน่าตื่นเต้นมาก บอกฉันหน่อยสิ พร้อมหรือยัง เพราะฉันรู้สึกดีกับเรื่องนี้มากเลย ฉันคิดอยู่บ่อย ๆ ว่าเรามาไกลแค่ไหนแล้ว และพูดตามตรง มันยังทำให้ฉันประหลาดใจทุกครั้ง ดูสิว่าเราสองคนสร้างอะไรขึ้นมาด้วยกันบ้าง',
      'มาหายใจเข้าลึก ๆ ช้า ๆ ด้วยกัน แล้วเราค่อยเริ่ม ฉันอยากบอกอะไรคุณสักอย่าง และฉันพูดจากใจจริง ขอบคุณนะ ขอบคุณจริง ๆ มันมีความหมายกับฉันมากกว่าที่คุณคิด หลายคนถามว่าฉันทำยังไงถึงไปต่อได้ คำตอบตามตรงคือฉันก็ไม่ได้ไปต่อได้ทุกครั้ง บางวันนั่งลงแล้วก็ไม่มีอะไรออกมาเลย แต่ฉันคิดว่าวันที่เงียบ ๆ ก็สำคัญเหมือนกัน มันสอนให้เราอดทน เพราะฉะนั้นเราจะค่อย ๆ ก้าวไปทีละก้าวเล็ก ๆ แล้วเราจะไปถึงแน่นอน ฉันสัญญาว่ามันจะคุ้มค่าทุกนาที และเมื่อเราไปถึงจริง ๆ ฉันอยากให้คุณจำช่วงเวลานี้เอาไว้ ตรงนี้ ตอนที่เพิ่งเริ่มต้น',
    ],
  ],
  [
    'Turkish',
    'a neutral Turkish accent',
    [
      'Ah, merhaba! Seni görmek çok güzel. Açıkçası biraz zor bir gün geçirdim. Ama şu an seni burada görmek her şeyi değiştirdi. Söz veriyorum, harika olacak.',
      'Hadi, bunu birlikte yapalım. Öyle sabahlar oluyor ki her şey ağır geliyor, yorgunum ve bir yanım sadece yatakta kalmak istiyor. Ama sonra bütün bunlara neden başladığımı hatırlıyorum ve içimde bir şey yeniden yanıyor. Ah, ne kadar heyecan verici! Gerçekten, insanın içi kıpır kıpır oluyor. Söylesene — hazır mısın? Çünkü bu konuda içimde çok iyi bir his var. Buraya kadar ne kadar yol katettiğimizi sık sık düşünüyorum ve açıkçası her seferinde beni yine şaşırtıyor. Bak, ikimiz birlikte neler kurmuşuz.',
      'Birlikte yavaşça derin bir nefes alalım, sonra da başlayalım. Sana bir şey söylemek istiyorum ve gerçekten içtenlikle söylüyorum: teşekkür ederim. Cidden. Bu benim için tahmin edebileceğinden çok daha fazlasını ifade ediyor. İnsanlar bana nasıl devam ettiğimi soruyor; dürüst cevap şu ki her zaman devam edemiyorum. Bazı günler oturuyorum ve hiçbir şey gelmiyor. Ama sessiz günler de önemli bence. İnsana sabrı öğretiyorlar. O yüzden küçük adımlarla ilerleyeceğiz ve varacağız. Sana söz veriyorum, her dakikasına değecek. Ve sonunda oraya vardığımızda, tam da bu anı hatırlamanı istiyorum, burayı, en başını.',
    ],
  ],
  [
    'Vietnamese',
    'a neutral Vietnamese accent',
    [
      'Ồ, chào bạn! Thật vui khi được gặp bạn. Thành thật mà nói, hôm nay tôi hơi mệt. Nhưng nhìn thấy bạn ở đây, mọi thứ đã thay đổi. Tôi hứa, sẽ tuyệt vời lắm.',
      'Nào, chúng ta cùng làm nhé. Có những buổi sáng mọi thứ đều nặng nề, tôi mệt mỏi và chỉ muốn nằm mãi trên giường. Nhưng rồi tôi nhớ ra vì sao mình đã bắt đầu tất cả những điều này, và có thứ gì đó lại sáng lên. Và ôi, thật là háo hức! Thật đấy, tôi mong lắm rồi. Nói tôi nghe đi — bạn sẵn sàng chưa? Vì tôi có linh cảm rất tốt về chuyện này. Tôi hay nghĩ về chuyện chúng ta đã đi được xa đến thế nào, và thành thật mà nói, lần nào nghĩ lại tôi cũng thấy ngạc nhiên. Nhìn xem hai chúng ta đã cùng nhau dựng nên những gì.',
      'Chúng ta cùng hít một hơi thật sâu và thật chậm, rồi bắt đầu nhé. Tôi muốn nói với bạn một điều, và tôi nói thật lòng: cảm ơn bạn. Thật đấy. Điều đó có ý nghĩa với tôi hơn bạn tưởng rất nhiều. Người ta hay hỏi tôi làm sao đi tiếp được, và câu trả lời thành thật là không phải lúc nào tôi cũng đi tiếp nổi. Có những ngày tôi ngồi xuống mà chẳng có gì đến cả. Nhưng tôi nghĩ những ngày lặng lẽ cũng quan trọng. Chúng dạy ta kiên nhẫn. Vậy nên chúng ta sẽ đi từng bước nhỏ một, rồi sẽ tới thôi. Tôi hứa với bạn, từng phút đều xứng đáng. Và khi cuối cùng cũng đến nơi, tôi muốn bạn nhớ đúng khoảnh khắc này, ngay ở đây, lúc bắt đầu.',
    ],
  ],
];
// Chinese and Japanese run their clauses together with no separator, so their parts join with
// nothing. Everything else here joins with a space — including Thai, Lao, Khmer and Burmese,
// whose samples already use spaces as clause separators rather than word boundaries.
const VC_NOSPACE = new Set(['Chinese', 'Japanese']);
// The VALUE is how many parts to take; the label is what the user is buying. 10 s is one part,
// 30 s is two, 60 s is all three.
const VC_LENS = [
  ['10 s', 1],
  ['30 s', 2],
  ['60 s', 3],
];
// Where THIS choice sits inside the tradeoff the static note above it describes. The old note
// ended by describing the single fixed default; with three lengths a click apart it has to say
// what you just picked instead. 60 s is deliberately not softened — it is past the length the
// 07-17 ear test rejected, and the whole point of offering it is that the user knows that.
// Keyed 1/2/3 (VC_LENS' values), but read below with a general `number` — `n` is guaranteed one
// of them by the `!VC_LENS.some(...)` clamp in `vcApplyLang`, which the checker cannot see across
// the array. `Record<number,string>` says so honestly rather than pretending the key is checked.
/** @type {Record<number, string>} */
const VC_LENNOTE = {
  1: 'At 10 s you are on Chatterbox’s floor and well inside VoxCPM2’s clean range — the safe choice, and the default.',
  2: '30 s buys a richer reference and still stops short of the ~36 s where drift showed up. Listen to the <i>end</i> of a candidate before you save it.',
  3: '60 s is what Chatterbox would rather clone from, but it is <b>past</b> the ~36 s where drift showed up in testing — expect a real chance of echo, breath pops or artifacts near the end. Listen to the <i>end</i> of a candidate carefully, and re-roll if you hear them.',
};
// What the boxes held when we last filled them in. A box the USER has typed into no longer
// matches, and is left alone — the same rule the upload name-prefill follows. Their work is
// never destroyed by reaching for a dropdown.
let vcFilled = { prompt: '', sample: '' };
/**
 * @param {[string,string,string[]]} e - one `VC_LANGS` entry.
 * @param {number} n - how many cumulative parts to take.
 */
function vcSampleFor(e, n) {
  return e[2].slice(0, n).join(VC_NOSPACE.has(e[0]) ? '' : ' ');
}
// Both dropdowns land here: language picks WHICH passage, length picks HOW MUCH of it, and the
// description only ever moves for the language. `force` is for startup, where the boxes are ours
// by definition and there is no user text to protect.
/**
 * @param {string} name
 * @param {boolean} force
 */
function vcApplyLang(name, force) {
  const e = VC_LANGS.find(l => l[0] === name) || VC_LANGS[0];
  let n = +(/** @type {HTMLSelectElement} */ ($('vcLen')).value);
  if (!VC_LENS.some(l => l[1] === n)) n = 1;
  const desc = VC_DESC(e[1]),
    sample = vcSampleFor(e, n);
  const p = /** @type {HTMLTextAreaElement} */ ($('vcPrompt')),
    s = /** @type {HTMLTextAreaElement} */ ($('vcSample'));
  // Decided BEFORE the write, because the note has to say whether the box actually moved.
  const sMine = force || !s.value.trim() || s.value === vcFilled.sample;
  if (force || !p.value.trim() || p.value === vcFilled.prompt) p.value = desc;
  if (sMine) s.value = sample;
  vcFilled = { prompt: desc, sample: sample };
  // Picking a length and watching nothing happen is the one confusing case: the box is the
  // user's own text, so we left it alone (as promised) — say so rather than letting it read as
  // a dead control.
  /** @type {VEl} */ ($('vcLenNote')).innerHTML =
    VC_LENNOTE[n] +
    (sMine ? '' : ' <b>Your own sample text is untouched</b> — clear the box if you want the ready-made passage at this length.');
  try {
    UIS.setItem('vocalis-vc-lang', name);
    UIS.setItem('vocalis-vc-len', String(n));
  } catch (e2) {}
}
(function vcInitLang() {
  /** @type {VEl} */ ($('vcLang')).innerHTML = VC_LANGS.map(l => `<option>${esc(l[0])}</option>`).join('');
  /** @type {VEl} */ ($('vcLen')).innerHTML = VC_LENS.map(l => `<option value="${l[1]}">${esc(l[0])}</option>`).join('');
  let want = 'English',
    wantLen = 1;
  try {
    want = UIS.getItem('vocalis-vc-lang') || 'English';
  } catch (e) {}
  try {
    wantLen = Number(UIS.getItem('vocalis-vc-len')) || 1;
  } catch (e) {}
  if (!VC_LANGS.some(l => l[0] === want)) want = 'English';
  if (!VC_LENS.some(l => l[1] === wantLen)) wantLen = 1;
  /** @type {HTMLSelectElement} */ ($('vcLang')).value = want;
  /** @type {HTMLSelectElement} */ ($('vcLen')).value = String(wantLen);
  // Seed vcFilled from the markup's defaults so an untouched English box still counts as
  // "ours" and swaps cleanly on the first change. 🔴 The markup ships English at 10 s, so it
  // must stay byte-identical to VC_LANGS[0][2][0] — the smoke test pins that.
  vcFilled = {
    prompt: /** @type {HTMLTextAreaElement} */ ($('vcPrompt')).value,
    sample: /** @type {HTMLTextAreaElement} */ ($('vcSample')).value,
  };
  if (want !== 'English' || wantLen !== 1) vcApplyLang(want, true);
  else /** @type {VEl} */ ($('vcLenNote')).innerHTML = VC_LENNOTE[1];
  /** @type {VEl} */ ($('vcLang')).addEventListener('change', () =>
    vcApplyLang(/** @type {HTMLSelectElement} */ ($('vcLang')).value, false),
  );
  /** @type {VEl} */ ($('vcLen')).addEventListener('change', () =>
    vcApplyLang(/** @type {HTMLSelectElement} */ ($('vcLang')).value, false),
  );
})();
// `remember` is false only for the forced fallback below: a missing venv drags you to Upload, and
// a move you did not make must not overwrite the sub-tab you actually chose. Reinstall VoxCPM2 and
// you are back where you were.
/**
 * @param {string} name - 'upload' or 'create' at runtime; see `vcstate.js`'s `vcTab` note.
 * @param {boolean} [remember]
 */
function switchVTab(name, remember) {
  vcTabSet(name);
  if (remember !== false)
    try {
      UIS.setItem('vocalis-vtab', name);
    } catch (e) {} // survive a reload
  document
    .querySelectorAll('#vTabs button')
    .forEach(b => b.classList.toggle('active', /** @type {HTMLElement} */ (b).dataset.vtab === name));
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-vcpanel]')).forEach(
    s => (s.style.display = s.dataset.vcpanel === name ? '' : 'none'),
  );
  // The list below is filtered BY TAB (§14.5) — re-render from what we already have rather
  // than refetching. Only once there IS something: rendering an empty store before the first
  // load would replace "Loading…" with "No uploaded voices.", which reads as an answer.
  //
  // 🔴 THE GUARD DID NOT DO WHAT THIS COMMENT SAYS. It was `if (state.vlist)`, and `[]` IS
  // TRUTHY — so an empty store walked straight through the check written to stop it, and
  // painted "No uploaded voices." over a list whose fetch was still in flight. Nothing
  // re-renders afterward, so the DOM and the state stay diverged until something unrelated
  // paints: the voices are fine and the page is lying about them.
  //
  // ⚠️ `dataset.loaded` IS THE RIGHT SIGNAL, NOT `.length`. A genuinely empty library must
  // still render its empty state — the question this guard asks is 'has a load HAPPENED',
  // not 'is there anything in it', and `loadVoiceList` sets that flag exactly once it has.
  if (/** @type {VEl} */ ($('vList')).dataset.loaded) renderVoiceList();
  // 7.0-m7: the candidate list and the batch are the SERVER's, so entering the tab is when this
  // browser finds out what happened while it was not looking — an overnight run, or another
  // window's deletes. Fetched here rather than at boot because a user who never opens Create
  // should not pay for either request.
  if (name === 'create') {
    loadCandidates();
    vcBatchPoll();
    loadVoiceTemplates();
  }
}
/** @type {VEl} */ ($('vTabs')).addEventListener('click', e => {
  // A click cancels any parked restore — otherwise /health landing a moment later would yank the
  // user off the tab they just chose.
  //
  // ⚠️ BOUND ONCE WITH A REAL CAST, NOT BY ANNOTATING THE PARAMETER. `@param {MouseEvent & {
  // target: HTMLElement }} e` reads as harmless and is UNSOUND: addEventListener hands this a
  // plain MouseEvent whose `target` is honestly `EventTarget | null`, so a listener demanding
  // the intersection is not assignable where one taking MouseEvent is expected. 8.8-m7 found it.
  const tab = /** @type {HTMLElement} */ (e.target);
  if (tab.dataset.vtab && tab.style.display !== 'none') {
    vcTabWant = null;
    switchVTab(tab.dataset.vtab);
  }
});
// ── Voice-design templates (7.0-m7 §17) ──────────────────────────────────
// Saved templates keep the description, sample text, and quality steps in the encrypted vault.
//
// 🔴 NOT LOCALSTORAGE for the list (§17.2) — the UIS block sweeps every `vocalis-*` key out of
// localStorage on boot, so a template library kept there would vanish on the next load with
// nothing reporting it. The SORT CHOICE goes through UIS, which is the server-side ui_state.yaml
// and is a different thing entirely; that is the same channel `vocalis-vc-lang` uses.
/**
 * A voice-design template, server-side (`runtime/voice_templates.py`'s `VoiceTemplate.to_dict()`)
 * — `GET /voices/templates`' rows and `POST`'s single-row replies (create/update) are the same
 * shape.
 * @typedef {object} VoiceTemplate
 * @property {string} id
 * @property {string} name
 * @property {string} prompt
 * @property {string} sample_text
 * @property {number} steps
 * @property {boolean} favorite
 * @property {number} used
 * @property {number} created_at
 * @property {number} updated_at
 */
/** @type {VoiceTemplate[]} */
let vcTpls = [];
let vcTplSort = 'name';
try {
  const s = UIS.getItem('vocalis-vctplsort');
  if (s === 'name' || s === 'new') vcTplSort = s;
} catch (e) {}
/** @type {HTMLSelectElement} */ ($('vcTplSort')).value = vcTplSort; // the control must show the order it is actually using
// Favorites float, they do not filter (§16.6) — star one and it moves to the top of whichever
// order is showing, disturbing nothing else. Array.sort is stable, so the two compose for free.
/** @param {VoiceTemplate[]} list */
function vcTplOrder(list) {
  return list.slice().sort(
    (a, b) =>
      (a.favorite ? 0 : 1) - (b.favorite ? 0 : 1) ||
      (vcTplSort === 'new'
        ? (b.created_at || 0) - (a.created_at || 0)
        : String(a.name || '').localeCompare(String(b.name || ''), undefined, {
            sensitivity: 'base',
          })),
  );
}
function vcTplSelected() {
  const id = /** @type {HTMLSelectElement} */ ($('vcTpl')).value;
  return vcTpls.find(t => t.id === id) || null;
}
/** @param {string} [keepId] */
function renderVoiceTemplates(keepId) {
  const sel = /** @type {HTMLSelectElement} */ ($('vcTpl')),
    want = keepId !== undefined ? keepId : sel.value;
  sel.innerHTML =
    '<option value="">— none —</option>' +
    vcTplOrder(vcTpls)
      .map(t => {
        // The usage count answers "which of these thirty do I actually reach for", which neither
        // the name nor the date can. Same reason the wbedit instruction picker carries one.
        const bits = [];
        if (t.used) bits.push(t.used + '×');
        bits.push(fmtDate(t.created_at));
        return `<option value="${esc(t.id)}">${t.favorite ? '⭐ ' : ''}${esc(t.name)} · ${esc(bits.join(' · '))}</option>`;
      })
      .join('');
  if (want && vcTpls.some(t => t.id === want)) sel.value = want;
  const cur = vcTplSelected();
  /** @type {HTMLButtonElement} */ ($('vcTplFav')).disabled = !cur;
  /** @type {VEl} */ ($('vcTplFav')).textContent = cur && cur.favorite ? '⭐' : '☆';
  /** @type {VEl} */ ($('vcTplFav')).title =
    cur && cur.favorite ? 'Remove the favorite' : 'Favorite this template — ★ float to the top of the list';
  /** @type {HTMLButtonElement} */ ($('vcTplUpdate')).disabled = !cur;
  /** @type {HTMLButtonElement} */ ($('vcTplDel')).disabled = !cur;
  vcTplState();
}
/** @param {string} [keepId] */
async function loadVoiceTemplates(keepId) {
  try {
    const j = await jget('/voices/templates');
    vcTpls = j.templates || [];
  } catch (e) {
    return;
  } // a transient failure must not blank a saved library
  renderVoiceTemplates(keepId);
}
// 🔴 THE `vcFilled` LINE IS THE WHOLE OF §17.3, AND THE DESIGN DOC HAD IT BACKWARD.
// `vcApplyLang` overwrites a box only when it STILL MATCHES what the app last auto-filled — that
// is how it tells its own default apart from text the user authored. §17.3 said a load "must set
// vcFilled to the template's own values", which is exactly the state that licenses the next
// language change to throw the template away. Clearing it instead makes the restored text read
// as authored, so changing the language afterward leaves it alone (and the length note says so).
/** @param {VoiceTemplate} t */
function vcTplApply(t) {
  /** @type {HTMLTextAreaElement} */ ($('vcPrompt')).value = t.prompt || '';
  /** @type {HTMLTextAreaElement} */ ($('vcSample')).value = t.sample_text || '';
  /** @type {HTMLInputElement} */ ($('vcSteps')).value = String(Math.max(4, Math.min(30, +t.steps || 30)));
  vcFilled = { prompt: '', sample: '' };
  // 📌 It FILLS THE FORM; IT DOES NOT GENERATE (§17.1). An auto-generate would spend both GPUs
  // on a template picked to read rather than to run.
  /** @type {VEl} */ ($('vcStatus')).textContent = `Loaded “${t.name}”. Edit anything you like, then Generate.`;
}
// 🔴 §17.4 — SHOW WHAT WILL ACTUALLY RUN. A selected template can differ from the current form
// contents if selection does not trigger a change event, the user edits the fields, or a reload
// restores language defaults.
//
// A selected template NAME and the CONTENTS OF THE BOXES are two different facts, and only the
// first was ever on screen. Whenever they disagree — because a re-pick of the ALREADY-selected
// option fires no `change` event at all, because the user edited the fields, or because a reload refilled the boxes
// from the language defaults — the page looked exactly as it does when they agree. This line makes
// the disagreement loud and gives him the one-click repair, so the failure cannot be silent again.
function vcTplState() {
  const el = $('vcTplState');
  if (!el) return;
  const t = vcTplSelected();
  if (!t) {
    el.textContent = '';
    return;
  }
  const same =
    /** @type {HTMLTextAreaElement} */ ($('vcPrompt')).value === (t.prompt || '') &&
    /** @type {HTMLTextAreaElement} */ ($('vcSample')).value === (t.sample_text || '');
  if (same) {
    el.innerHTML = `Using <b>${esc(t.name)}</b> — the boxes below are what Generate and Batch will use.`;
    el.style.color = '';
    return;
  }
  // ⚠️ NOT AN ERROR, and it must not read as one: editing after loading a template is ordinary and
  // the edited text is what he asked to run. The point is only that it is no longer the template.
  el.innerHTML =
    `The boxes below have been edited and no longer match <b>${esc(t.name)}</b>. ` +
    `They are what Generate and Batch will use. ` +
    `<button class="xs" id="vcTplReapply" style="margin-left:4px">↻ Re-apply ${esc(t.name)}</button>`;
  el.style.color = 'var(--warn)';
  /** @type {VEl} */ ($('vcTplReapply')).onclick = () => {
    vcTplApply(t);
    vcTplState();
  };
}
// Every box that feeds a run repaints the line. `input`, not `change`, so it keeps up with typing
// rather than waiting for a blur he may never do before pressing Generate.
['vcPrompt', 'vcSample', 'vcSteps'].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener('input', vcTplState);
});
/** @type {VEl} */ ($('vcTpl')).addEventListener('change', () => {
  const t = vcTplSelected();
  renderVoiceTemplates();
  if (!t) {
    vcTplState();
    return;
  }
  vcTplApply(t);
  vcTplState();
  // Fire-and-forget: the form was filled from the list we already had, so counting the load must
  // never sit between the click and the boxes changing.
  jpost('/voices/templates/' + encodeURIComponent(t.id) + '/use', {})
    .then(() => {
      t.used = (t.used || 0) + 1;
      renderVoiceTemplates();
    })
    .catch(() => {});
});
/** @type {VEl} */ ($('vcTplSort')).addEventListener('change', () => {
  vcTplSort = /** @type {HTMLSelectElement} */ ($('vcTplSort')).value === 'new' ? 'new' : 'name';
  try {
    UIS.setItem('vocalis-vctplsort', vcTplSort);
  } catch (e) {}
  renderVoiceTemplates();
});
/** @type {VEl} */ ($('vcTplSave')).onclick = async () => {
  const name = await promptForName({
    title: 'Save as a template',
    blurb: 'Saves the description, the sample text and the quality steps, under a name you can pick from the drop-down later.',
    placeholder: 'e.g. Warm American narrator',
    required: 'Give the template a name.',
    okLabel: 'Save template',
  });
  if (name === null) return;
  try {
    // 🔴 SAVE ALWAYS CREATES (§17.4) — editing is the ⤓ Update button, by id. Two templates may
    // share a name; the id is the identity. A save that quietly replaced a same-named entry
    // would destroy the older one with no warning.
    const t = await jpost('/voices/templates', {
      name,
      prompt: /** @type {HTMLTextAreaElement} */ ($('vcPrompt')).value,
      sample_text: /** @type {HTMLTextAreaElement} */ ($('vcSample')).value,
      steps: +(/** @type {HTMLInputElement} */ ($('vcSteps')).value) || 30,
    });
    await loadVoiceTemplates(t.id);
  } catch (e) {
    await modal(
      'Couldn’t save the template',
      esc(
        /** @type {string | undefined} */ (/** @type {ErrLike} */ (e).body && /** @type {ErrLike} */ (e).body.message) ||
          /** @type {ErrLike} */ (e).message,
      ),
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
  }
};
// §17.4 — the SAVE trigger (formerly "⤓ Update"). The label is "Save" because "Update"
// implied the template was the live thing and the boxes were a copy tracking it.
/** @type {VEl} */ ($('vcTplUpdate')).onclick = async () => {
  const t = vcTplSelected();
  if (!t) return;
  // Confirmed, unlike Save as…: this replaces the saved template text and has no undo.
  const go = await modal(
    'Save into this template?',
    `Replace <b>${esc(t.name)}</b>’s description, sample text and quality steps with what is in the boxes now?`,
    [
      { label: 'Cancel', value: 0 },
      { label: 'Save', class: 'primary', value: 1 },
    ],
  );
  if (!go) return;
  try {
    await jpost('/voices/templates/' + encodeURIComponent(t.id), {
      prompt: /** @type {HTMLTextAreaElement} */ ($('vcPrompt')).value,
      sample_text: /** @type {HTMLTextAreaElement} */ ($('vcSample')).value,
      steps: +(/** @type {HTMLInputElement} */ ($('vcSteps')).value) || 30,
    });
    await loadVoiceTemplates(t.id);
    /** @type {VEl} */ ($('vcStatus')).textContent = `Saved “${t.name}”.`;
  } catch (e) {
    await modal(
      'Couldn’t save the template',
      esc(
        /** @type {string | undefined} */ (/** @type {ErrLike} */ (e).body && /** @type {ErrLike} */ (e).body.message) ||
          /** @type {ErrLike} */ (e).message,
      ),
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
  }
};
/** @type {VEl} */ ($('vcTplFav')).onclick = async () => {
  const t = vcTplSelected();
  if (!t) return;
  try {
    await jpost('/voices/templates/' + encodeURIComponent(t.id), { favorite: !t.favorite });
    await loadVoiceTemplates(t.id);
  } catch (e) {}
};
/** @type {VEl} */ ($('vcTplDel')).onclick = async () => {
  const t = vcTplSelected();
  if (!t) return;
  const go = await modal('Delete this template?', `<b>${esc(t.name)}</b> goes for good. The voices you made with it are untouched.`, [
    { label: 'Cancel', value: 0 },
    { label: 'Delete', class: 'danger', value: 1 },
  ]);
  if (!go) return;
  try {
    await jdel('/voices/templates/' + encodeURIComponent(t.id));
    await loadVoiceTemplates('');
  } catch (e) {
    await modal('Couldn’t delete the template', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
};
// Live model-state for the Create panel, driven off MODELS (refreshed every /health poll).
// 🔴 EXPORTED BECAUSE TWO MODULES OUTSIDE THIS FILE CALL IT AND NEITHER COULD REACH IT. m8b moved
// this function out of the page and left `setModelUI` (js/sys/model.js:161) and `vcPoll`
// (js/voice/candidates.js:79,84) calling the bare name. Under the shim that name was
// `window.vcSyncModel`; since m13 deleted the shim it has been an unresolved free identifier, so
// EVERY /health poll threw here — see the note on `setModelUI`. The export also keeps the health poll path callable.
export function vcSyncModel() {
  const avail = MODELS.voxAvail,
    st = MODELS.vox;
  /** @type {VEl} */ ($('vTabCreate')).style.display = avail ? '' : 'none';
  if (!avail) {
    vcTabWant = null;
    if (vcTabNow() === 'create') switchVTab('upload', false);
    return;
  } // venv gone — fall back to Upload
  // Availability is now known, so a parked sub-tab from the last session can be honored. Spent
  // once: after this, the tab is whatever the user last clicked.
  if (vcTabWant) {
    const w = vcTabWant;
    vcTabWant = null;
    if (w !== vcTabNow()) switchVTab(w);
  }
  const ready = st === 'ready',
    loading = st === 'loading';
  /** @type {VEl} */ ($('vcModelState')).textContent = ready ? 'VoxCPM2 is loaded.' : loading ? 'VoxCPM2 is loading…' : '';
  /** @type {VEl} */ ($('vcNotLoaded')).style.display = ready || loading ? 'none' : '';
  // While a design job runs the button becomes Cancel (always enabled, so you can abort a
  // slow draw); otherwise it's Generate — enabled whenever VoxCPM2 is INSTALLED, not only
  // when it's loaded (4.8-m2e). Generate loads the engine itself, and it has to: the reaper
  // unloads an idle one, so gating on `ready` would leave a dead button after ten quiet
  // minutes. The load shows up in the job log where the rest of the progress already is.
  const btn = /** @type {HTMLButtonElement} */ ($('vcGenBtn'));
  if (vc.busy) {
    btn.disabled = false;
    btn.textContent = '■ Cancel';
    btn.className = 'danger';
  } else {
    btn.disabled = false;
    btn.textContent = 'Generate';
    btn.className = 'primary';
  }
}
/** @type {VEl} */ ($('vcLoadBtn')).onclick = async () => {
  try {
    await jpost('/model/load', { which: 'voxcpm' });
  } catch (e) {
    await modal('Load failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
  pollReady();
};
// Generate is a cancelable BACKGROUND job (4.8-m2b): POST returns a job id, then we poll a
// live log and can abort. The one button is Generate when idle and Cancel while a job runs.
/** @type {VEl} */ ($('vcGenBtn')).onclick = async () => {
  if (vc.busy) {
    // the button is Cancel now
    if (vc.job) {
      try {
        await jpost('/voices/design/cancel/' + vc.job, {});
      } catch (e) {}
    }
    return; // the poller sees status=canceled and cleans up
  }
  const sample = /** @type {HTMLTextAreaElement} */ ($('vcSample')).value.trim();
  if (!sample) {
    await modal('No sample text', 'Give the voice a sentence to speak.', [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  // No seed on the wire (§14.3): the server draws one per free card.
  // 🔴 AND IT NO LONGER CLEARS THE LIST (§18.5). This used to do `vc.cands=[]` right here, which
  // would supersede prior candidates. A re-roll appends instead; candidates remain until deleted.
  const body = {
    prompt: /** @type {HTMLTextAreaElement} */ ($('vcPrompt')).value.trim(),
    sample_text: sample,
    steps: +(/** @type {HTMLInputElement} */ ($('vcSteps')).value) || 30,
  };
  /** @type {VEl} */ ($('vcLog')).style.display = 'none';
  /** @type {VEl} */ ($('vcLog')).textContent = '';
  let j;
  try {
    j = await jpost('/voices/design', body);
  } catch (e) {
    const code = /** @type {ErrLike} */ (e).body && /** @type {ErrLike} */ (e).body.error;
    if (code === 'cards_busy' || code === 'no_gpu')
      await modal('Can’t generate yet', esc(/** @type {HttpErrorBody} */ (/** @type {ErrLike} */ (e).body).message), [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
    else await modal('Generate failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    return;
  }
  vc.job = j.job_id;
  vc.busy = true;
  vcSyncModel();
  // The count comes from the SERVER's reply — it's one candidate per free card (§14.3), so it
  // is 1 on a one-card box and however many cards a bigger one has free right now. Digits, not
  // words: this used to say "two voices" for any n>1, which was a lie on a four-card box and
  // read as a promise of two on a one-card box.
  /** @type {VEl} */ ($('vcStatus')).innerHTML =
    '<span class="spin"></span> Designing ' +
    vcN(j.n || 1, 'voice') +
    '… (~30–60 s — includes cleanup + enhancement; the first draw after loading warms up)';
  vcPoll();
};

// 7.5.6 — hand both to ./vcstate.js so sys/model.js, voice/candidates.js and ui/tabs.js can
// fire them without importing this file. Those three imports were the four-module cycle the
// bundle exposed; see vcstate.js for the argument.
// 📌 At the END of the file so both functions are defined whichever order they are declared in.
onVcSyncModel(vcSyncModel);
onVoiceListLoad(loadVoiceList);
