// st/chars.js — the SillyTavern ▸ Characters tab: the per-character voice map, the round face
// beside each row, and the live poll that inserts a character the moment a chat opens (7.3-m11b,
// closing §5's m11 apart from the sub-tabs, which are tab machinery and belong to ui/tabs.js).
//
// 220 lines out of THREE adjacent banners, one contiguous cut — `── SillyTavern tab: character ->
// voice/params ──`, `── m4h / §9a.2: the round face ──` and `── live refresh ──`. They interlock
// the way the scenes family does: the middle one reaches eight names the first declares and leaks
// five back to it, and the third reaches nine across both. There was no smaller cut.
//
// Rows edit PER-CHARACTER entries in the `sillytavern` section of voice_settings.yaml (a missing
// value is the chatterbox default — no per-voice fallback). ▶ Audition renders the on-screen
// values and persists NOTHING; only the green Save does, and it PUTs the full map, so removing a
// row deletes that character.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — five names, and 🔴 ONLY TWO OF THEM ARE FOR THIS PAGE'S OWN TAB MACHINERY.
//
//   loadStChars   `switchStTab`'s `case 'characters'` — entering the sub-tab is what loads it.
//                 ↻ Refresh and `saveStChars`'s tail call it too, and both are wired below.
//   stPollStop    TWO callers in the tab machinery, and they are the reason this is a pair with
//                 the one above: `switchTab`'s `if(name!=='sillytavern')` and `switchStTab`'s
//                 leave arm. LEAVING is what stops the 4-second character poll and nothing else
//                 can. Same shape as st/log.js (m4k) and st/nomi.js (m11a), and their headers
//                 say the same thing because the second name is the easy one to lose.
//   stLoadFaces   🔴 THE CLIPS TAB, not the tab machinery: `loadScenes` races it alongside
//   stFaceFor     GET /clips/items, and the Character column draws `stFaceFor(who[0],{},20)`.
//   stPollRunning 🔴 A SPEC, and nothing else — the only line in this file that is not a verbatim
//                 move. tests/st_characters_live_spec.mjs asserts the poll's scope at six points
//                 and every one of them used to read `stPollTimer` off the page. The long note is
//                 down beside the function; the short version is that publishing the `let`
//                 instead would have made three of those six checks pass against a stale null.
//
// 📌 EXPORTING FOR A SPEC IS ESTABLISHED HERE, NOT A CONCESSION: sys/devices.js publishes
// `renderDevices`/`devs` for one (m4a) and voice/candidates.js publishes eight (m4d). A spec
// caller is a caller. What is NOT allowed is publishing the mutable state itself.
//
// 🔴 SO HALF THE EXPORT SURFACE CROSSES A FEATURE BOUNDARY, AND IT IS NOT AN ACCIDENT OF THIS
// CUT. m4i/§9a.3 deliberately reused m4h's join rather than reimplementing it — same card store,
// same `st_ref` identity join, same `wbFaceHtml` fallback circle — and the alternative was two
// implementations of "whose voice is this?" drifting apart. When §5's m7 moves the scenes family,
// these two stop being read off the shim and become an ordinary module-to-module import, which is
// the direction of travel. Until then they must stay on the Object.assign.
//
// ⚠️ TWENTY-ONE NAMES STAY PRIVATE, the whole dirty/baseline machine among them. The measured
// leak count out of the 220-line range was exactly the four above.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ `stVoiceOpts` COMES WITH THE CUT AND GOES PRIVATE, WHICH CLOSES THE LOOP m4u OPENED.
//
// It could not have. `ui/audition.js`'s `wireClearCache` used to read
// `stVoiceOpts.length ? stVoiceOpts : nomiOpts` — a shared ui/ helper naming two sibling
// features' state — so BOTH names were pinned to the page: make either private and the other
// feature's 🧹 Clear cached button becomes a ReferenceError. m4u turned that list into a
// parameter (`optsOf`, a thunk, read at click time), `st/nomi.js` took `nomiOpts` private in the
// same commit, and this module takes the last one. Neither name is declared in index.html now.
//
// 📌 That is §11.14's argument end to end: a constraint two commits had recorded as a permanent
// fact was one question — *why does the helper want the global?* — away from not existing.
//
// ⚠️ `stFaces`, `stBaseline`, `stLast`, `stSeq` and `stPollTimer` are private `let`s for the
// ordinary reason (§11.4): this file is their only reader and their only writer, so there is
// nothing left in the page to fork against.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ✅ THREE NAMES LEAVE `_PARSE_TIME_SURFACE`, ALL THREE THE EASY WAY (Landmine 1).
//
// `$('stRefresh').onclick=loadStChars`, `$('stSave').onclick=saveStChars` and the top-level
// `for(const ev of ['input','change'])` that wires `stCheckDirty` over #stList and #stDefaultWrap
// were all INSIDE the moved range, so all three traveled with their functions and resolve
// locally against a hoisted declaration. No arrow was needed and nothing deferred is left behind
// in the page. That takes the running total to nine names out, seven of them without an arrow.
//
// ⚠️ `ST_TABS` STAYS. `_PARSE_TIME_SURFACE`'s note on it says it "moves with `st/chars.js`, m11"
// — it does not. It is declared under `── SillyTavern sub-tabs: Logs | Characters ──`, which is
// `stTab`/`switchStTab` tab machinery filed under §5's m2 `ui/tabs.js`, and a top-level restore
// reads it. §11.12: the plan is a plan, and this module read the defs instead.
//
// ⚠️ SIX INLINE GLOBALS ARE STILL REACHED AT CALL TIME, all of them safe (§3.1) and all
// scheduled: `voiceClusterHTML` and `clusterIds` (§4 files both under ui/voicepicker.js and
// 🔴 NEITHER IS THERE YET — m4q took voiceOptionsHTML/useDefaultLabel and left these two, which
// is exactly the §11.12 trap that cost m4t a SyntaxError); `stepVoice` and `curParams`, same
// file, same story; `loadPgLib`, which becomes an import at pg/*; and `stTab`, read by
// `stCharsOpen` and moving at m2.

import { $, esc } from '../util/dom.js';
import { jget } from '../util/http.js';
import { modal } from '../ui/modal.js';
import {
  voiceOptionsHTML,
  useDefaultLabel,
  UNSET_DEFAULT_LABEL,
  voiceClusterHTML,
  clusterIds,
  voiceOptText,
  voiceLabelOf,
} from '../ui/voicepicker.js'; // 7.3-m12c: last two were inline globals
import {
  updateAudition,
  wireAudCluster,
  wireClearCache,
  runAudition,
  clearVoiceCache,
  onCacheStats,
  fmtCacheBytes,
  speakerCacheStats,
} from '../ui/audition.js';
// 🔴 THE SAME CIRCLE THE LIBRARY DRAWS, REUSED RATHER THAN REIMPLEMENTED. `wbFaceHtml` renders the
// initial-letter fallback when `avatar` is false, which is why a character with no card in the
// library — the common case, not an edge case — gets a letter and never a broken image.
import { wbFaceHtml } from '../wb/face.js';
// ⚠️ 7.3-m2b: `stCharsOpen()` asked the bare `stTab` whether this pane is the one showing. That
// `let` is js/st/tabstate.js's now, and it is read through an accessor because it is reassigned —
// a shim copy would be frozen. tabstate.js imports nothing, so this cannot be a cycle even though
// js/st/tabs.js imports `loadStChars` and `stPollStop` from here.
import { stTabNow } from './tabstate.js';
import { stepVoice } from '../ui/voicepicker.js'; // 7.3-m6d: was an inline global
// 🔴 `curParams` IS USED AT :251 IN THE PER-ROW AUDITION HANDLER AND WAS NEVER IMPORTED. m12c moved
// it into js/voice/params.js, and that module was never on the shim's `Object.assign` list — so
// unlike most of this class the name has been unresolved since m12c rather than since m13. The
// read is inside an `onclick` arrow, so wiring succeeded and only the CLICK failed: ▶ Audition on
// every SillyTavern character row did nothing at all; the handler resolved the name only when
// clicked, so module wiring itself gave no warning.
import { curParams } from '../voice/params.js';
import { pgLibLoad } from '../pg/pgstate.js'; // 7.5.6 — was `loadPgLib` from playground.js
// ── SillyTavern tab: character -> voice/params (the `sillytavern` section of
// voice_settings.yaml, server-side). Rows edit PER-CHARACTER entries (a missing
// value is the chatterbox default — no per-voice fallback); Audition renders
// the on-screen values and saves NOTHING — only the Save button persists
// (PUT /st/characters, full map, so removing a row deletes that character).
/**
 * One character's entry in the `sillytavern` section of voice_settings.yaml — `/st/characters`'s
 * `characters[name]`, and what green Save PUTs back. `avatar` doubles as the face join's key
 * (`st_ref`, see the round-face banner below) and `name`/`last_seen` are carried on a live-poll
 * insert's record even though the map key is already the name.
 * @typedef {object} StCharEntry
 * @property {string} [voice]
 * @property {number} [exaggeration]
 * @property {number} [cfg]
 * @property {number} [temperature]
 * @property {string} [avatar]
 * @property {string} [name]
 * @property {string} [last_seen]
 */
/** @type {VoiceRow[]} */
let stVoiceOpts = [],
  stSeq = 0;
/**
 * A `.stRow` element. `stRowHTML` writes BOTH data attributes on every row it builds, so `name`
 * and `pre` are `string` here and not `string|undefined` - a row without them never exists.
 * @typedef {HTMLElement & { dataset: { name: string; pre: string } }} StRowEl
 */
/** @param {string} pre */
const stF = pre => ({ exag: pre + 'Exag', cfg: pre + 'Cfg', temp: pre + 'Temp' });
export async function loadStChars() {
  try {
    // m4h / §9a.2 — the faces before the rows, because `stRowHTML` reads the map synchronously.
    // 🔴 BOTH IN FLIGHT AT ONCE. Two awaits in sequence would put a second round trip in front of
    // a list awaiting render, for a decoration; `stLoadFaces` swallows its own errors, so the
    // pair cannot fail together.
    const [r] = await Promise.all([jget('/st/characters'), stLoadFaces()]);
    stVoiceOpts = r.voice_options || [];
    renderStChars(r.characters || {}, r.default_voice || '');
    pgLibLoad().then(() => {
      // ALWAYS re-read the clip list from disk on tab open —
      // cached-audition players must reflect deletions made elsewhere
      /** @type {NodeListOf<StRowEl>} */ (document.querySelectorAll('#stList .stRow')).forEach(r2 => {
        const f = stF(r2.dataset.pre);
        updateAudition(f, r2.dataset.pre + 'Voice', r2.dataset.pre + 'AudOut');
      });
    });
    // Live-insert characters SillyTavern registers while this tab is open — but only if it
    // still IS open: the GET above is awaited, so a switch away during it would otherwise
    // start a poll AFTER the switch handler stopped it, and leave it running for good.
    if (stCharsOpen()) stPollStart();
  } catch (e) {
    /** @type {VEl} */ ($('stList')).innerHTML =
      '<span class="muted">Failed to load: ' + esc(/** @type {ErrLike} */ (e).message) + '</span>';
  }
}
const stCharsOpen = () =>
  stTabNow() === 'characters' &&
  /** @type {HTMLElement} */ (/** @type {VEl} */ ($('stList')).closest('section[data-panel]')).style.display !== 'none';
// Save is disabled until the tab's state actually DIFFERS from what was
// loaded (then it goes GREEN): every input/change/removal re-compares the
// collected rows against a baseline snapshot, so undoing an edit by hand
// disables Save again. ↺ Reset re-renders the last saved state.
let stBaseline = '',
  /** @type {{chars: Record<string, StCharEntry>, def: string}} */ stLast = { chars: {}, def: '' };
// Names the user deleted (pending Save) — the live poll must not resurrect them.
const stRemoved = new Set();
function stCollect() {
  /** @type {Record<string, StCharEntry>} */
  const chars = {};
  /** @type {NodeListOf<StRowEl>} */ (document.querySelectorAll('#stList .stRow')).forEach(r => {
    const pre = r.dataset.pre,
      f = stF(pre);
    chars[r.dataset.name] = {
      voice: /** @type {HTMLSelectElement} */ ($(pre + 'Voice')).value,
      exaggeration: +(/** @type {HTMLInputElement} */ ($(f.exag)).value),
      cfg: +(/** @type {HTMLInputElement} */ ($(f.cfg)).value),
      temperature: +(/** @type {HTMLInputElement} */ ($(f.temp)).value),
    };
  });
  return { characters: chars, default_voice: $('stDefVoice') ? /** @type {HTMLSelectElement} */ ($('stDefVoice')).value : '' };
}
/** @param {boolean} d */
function stSetDirty(d) {
  const b = /** @type {HTMLButtonElement} */ ($('stSave'));
  b.disabled = !d;
  b.classList.toggle('ok', d);
  b.classList.toggle('primary', !d);
  /** @type {HTMLButtonElement} */ ($('stReset')).disabled = !d;
}
function stCheckDirty() {
  stSetDirty(JSON.stringify(stCollect()) !== stBaseline);
}
for (const ev of ['input', 'change']) {
  /** @type {VEl} */ ($('stList')).addEventListener(ev, stCheckDirty);
  /** @type {VEl} */ ($('stDefaultWrap')).addEventListener(ev, stCheckDirty);
}
/** @type {VEl} */ ($('stReset')).onclick = () => renderStChars(stLast.chars, stLast.def);
const ST_EMPTY_HTML = '<span class="muted">No characters yet — open a chat in SillyTavern and it appears here.</span>';
// ── m4h / §9a.2: the round face beside a Character Voices row ────────────────────────────────
//
// 🔴 **JOINED ON `st_ref`, NOT ON THE NAME, AND THAT IS THE WHOLE DESIGN QUESTION ANSWERED.** The
// design doc set this up as a name → document lookup and then had to ask what a collision renders,
// because two characters can share a name and showing an arbitrary one of two faces is worse than
// showing none. But m5b already gave the voice registry SillyTavern's own primary key — the avatar
// FILENAME (§8.2, `_clean_avatar`) — and a wbedit card document carries the same string in
// `st_ref`. So the join is an identity join and the collision cannot arise.
//
// ⚠️ **THE NAME IS THE FALLBACK, AND ONLY WHEN IT IS UNAMBIGUOUS.** An entry written before m5b
// has no `avatar` (the registry adopts one on first sighting rather than orphaning his voice
// assignment — `_resolve_locked`), so those still need the name. If exactly one card matches, use
// it; if two do, draw the initial rather than guess, which is what the design asked for.
//
// ⚠️ **A CHARACTER WITH NO CARD IN THE LIBRARY IS THE COMMON CASE, NOT AN EDGE CASE.** He has
// narrated for characters he never imported. Those get `wbFaceHtml`'s initial-letter circle — the
// same one the Library uses — never a broken image.
/** Document metadata joined into a SillyTavern character or persona row.
 * * @typedef {object} StFaceDoc
 * @property {string} id
 * @property {string} [kind] - `card` or `persona`; the Clips face (`stSceneFaceFor`) prefers a card.
 * @property {number} [imported_at] - epoch seconds; the Clips face's last tie-break.
 * @property {string} [st_ref] - SillyTavern's own avatar filename; absent on an unsent document
 *   and on a card created before m5b, which is why the name fallback below exists at all.
 * @property {string} [name]
 * @property {boolean} [avatar] - whether a picture EXISTS, never a path.
 *  *
 *   🔴 THIS SAID `string|boolean` AND "the served picture path", AND THE ROUTE HAS NEVER SENT
 *   ONE. `wbedit.py:545` is `"avatar": store.has_asset(d.id, AVATAR)` and
 *   `wbedit/store/documents.py:1186` is `def has_asset(...) -> bool`. Nothing downstream survives
 *   on the difference — `wbFaceHtml` only ever asks `!doc.avatar` — which is exactly why a wrong
 *   type here could sit unnoticed: the first reader to believe it and write `<img src=doc.avatar>`
 *   is the one who finds out.
 *  *
 *   ⚠️ NOT THE SAME `avatar` AS `StCharEntry`'s, 60 lines below, and that collision is what made
 *   this hard to see. THAT one is SillyTavern's own filename, a real string, and it is the KEY
 *   into `byRef` — `F.byRef[e.avatar]`. One name, two routes, two types.
 * @property {string} [avatar_at] - the picture's `(size, mtime)`; `wbFaceHtml` stashes it for its
 *   fallback. This file never reads it — it is here because the row is passed through whole.
 * @property {string} [thumb_at] - 9.7.7 — the thumbnail's cache key, which `wbFaceHtml` puts in
 *   the `<img>` URL. Same reason: Character Voices draws the same circle out of the same rows, so
 *   a face replaced while this tab is open goes stale here too without it.
 */

/**
 * The face-join index `stLoadFaces()` builds and `stFaceFor()` reads. `byName[k]` is `null`
 * specifically to mean "two documents answer to this name", distinct from the key being absent.
 * @typedef {object} StFaces
 * @property {Record<string, StFaceDoc|null>} byRef
 * @property {Record<string, StFaceDoc|null>} byName
 * @property {Record<string, StFaceDoc[]>} [all] - 11.2.6: EVERY document per lowercased name, for
 *   `stSceneFaceFor`, which chooses among them where `byName` refuses to.
 * @property {boolean} loaded
 */
/** @type {StFaces} */
let stFaces = { byRef: {}, byName: {}, loaded: false };

export async function stLoadFaces() {
  try {
    // A voice row may represent the active user persona as well as a character. Personas are
    // stored in the same document library, but under their own kind; loading cards alone made a
    // persona row fall through to its initial even when its imported persona had a picture.
    const [cards, personas] = await Promise.all([jget('/wbedit/documents?kind=card'), jget('/wbedit/documents?kind=persona')]);
    /** @type {Record<string, StFaceDoc|null>} */
    const byRef = {};
    /** @type {Record<string, StFaceDoc|null>} */
    const byName = {};
    /** @type {Record<string, StFaceDoc[]>} */
    const all = {};
    [...(cards.documents || []), ...(personas.documents || [])].forEach(
      /** @type {(d: StFaceDoc) => void} */ (
        d => {
          // Card and persona avatars live in different SillyTavern directories, so the same leaf
          // filename can legitimately identify one of each. Without a kind on the voice row,
          // choosing either would be a guess; null means draw the initial instead.
          if (d.st_ref) byRef[d.st_ref] = d.st_ref in byRef ? null : d;
          const k = (d.name || '').trim().toLowerCase();
          if (!k) return;
          // `null` marks a name TWO documents answer to. Distinct from "absent" on purpose: absent means
          // look no further, null means we looked and must not choose.
          byName[k] = k in byName ? null : d;
          (all[k] ||= []).push(d);
        }
      ),
    );
    stFaces = { byRef, byName, all, loaded: true };
  } catch (e) {
    // A locked vault, or the wbedit store not reachable. Rows still render — with initials.
    // 🔴 Never let a decoration take the pane with it: the voice map is what this tab is FOR.
    stFaces = { byRef: {}, byName: {}, loaded: false };
  }
}

// 🔴 THE SECOND AND LAST NON-VERBATIM CHANGE IN THIS FILE, AND IT IS THE m4u MOVE AGAIN (§11.14).
// `faces` is a fourth parameter that defaults to the module's own map. It exists because
// tests/wbedit_browser_spec.mjs drives the `st_ref`-beats-name precedence rule directly, and the
// only way it could do that was `const saved = stFaces; stFaces = {…fixture…}; … stFaces = saved;`
// — reassigning a page global from a spec. `stFaces` is private now, so that threw.
//
// ⚠️ A SETTER WOULD HAVE BEEN THE SMALLER DIFF AND THE WORSE ANSWER. Publishing a mutator so a
// spec can inject state leaves the injection live if an exception skips the restore, and it hands
// the console a way to repoint the whole face map. A parameter makes `stFaceFor` a pure function
// of its inputs, which is what the spec actually wanted to test, and the save/restore dance goes
// away with it. Nothing else passes the argument — all four production call sites use the default.
/**
 * @param {string} name
 * @param {StCharEntry} [e]
 * @param {number} [px]
 * @param {StFaces} [faces]
 * @returns {string}
 */
export function stFaceFor(name, e, px, faces) {
  const size = px || 34;
  const F = faces || stFaces;
  const doc = (e && e.avatar && F.byRef[e.avatar]) || (!(e && e.avatar) ? F.byName[(name || '').trim().toLowerCase()] : null);
  if (doc) return wbFaceHtml(doc, size, { clickable: false });
  // No card, or an ambiguous name. `wbFaceHtml` draws the initial when `avatar` is false, so it
  // is reused rather than reimplemented — same circle, same letter, same size.
  return wbFaceHtml({ id: '', name: (e && e.name) || name, avatar: false }, size, {
    clickable: false,
  });
}

// 🔴 11.2.6 — THE CLIPS FACE CHOOSES, WHERE THE VOICE LIST REFUSES TO.
//
// A scene may have neither a matching avatar filename nor a unique name in the library. 11.2.5
// tried those lookups and drew an initial when both were unavailable.
//
// `stFaceFor` refuses an ambiguous name ON PURPOSE: a Character Voices row BINDS a voice, and a
// wrong guess there puts one character's voice on another. A Clips row binds nothing — it is a
// picture beside a name — so here the right answer to "several documents with the same display name" is to
// pick the best one rather than to draw a letter:
//   1. the exact SillyTavern avatar, when the scene recorded it (unique by construction);
//   2. else a CARD over a persona — a scene is built from character messages only, the
//      extension refuses the user's own (`Scenes are character messages only.`);
//   3. else one WITH a picture over one without;
//   4. else the most recently imported — two cards of one name are almost always one character
//      imported twice, and the newer copy is the one he has been working on.
/**
 * @param {string} name
 * @param {string} [avatar] - SillyTavern's avatar filename, when known
 * @param {number} [px]
 * @param {StFaces} [faces]
 * @returns {string}
 */
export function stSceneFaceFor(name, avatar, px, faces) {
  const size = px || 20;
  const F = faces || stFaces;
  let doc = (avatar && F.byRef[avatar]) || null;
  if (!doc) {
    const pool = ((F.all || {})[(name || '').trim().toLowerCase()] || []).slice();
    pool.sort(
      (a, b) =>
        Number(b.kind === 'card') - Number(a.kind === 'card') ||
        Number(!!b.avatar) - Number(!!a.avatar) ||
        (b.imported_at || 0) - (a.imported_at || 0),
    );
    doc = pool[0] || null;
  }
  if (doc) return wbFaceHtml(doc, size, { clickable: false });
  return wbFaceHtml({ id: '', name, avatar: false }, size, { clickable: false });
}

// One row's markup and one row's wiring, split apart so the initial render and
// the live poll below build IDENTICAL rows (same split as appendNomiRow).
/**
 * @param {string} n
 * @param {StCharEntry} [e]
 * @returns {string}
 */
function stRowHTML(n, e) {
  const pre = `st${stSeq++}`;
  e = e || {};
  // 11.3.0 — COLLAPSED BY DEFAULT. The header shows the current voice as read-only text; opening
  // the row reveals the editable controls. The header is
  // the old name strip plus a caret and the voice; the voice cluster moved into `.stBody`, which the
  // stem-set rows' `.open` rule shows and hides (css/sillytavern.css). The header text follows the
  // select live — see `stPaintVoiceTxt`.
  return `
    <div class="stRow${stOpen.has(n) ? ' open' : ''}" data-name="${esc(n)}" data-pre="${pre}" style="border-top:1px solid rgba(128,128,128,.25);padding-top:10px;margin-top:10px">
      <div class="stHead" title="Click to show or hide this character's voice and delivery">
        <!-- The name and its "seen" date were separated by a single literal space, which at this
             font size reads as one run-on string. A real gap, and the
             date is pushed off the baseline of the name rather than crowding it. -->
        <!-- m4h / §9a.2 — the face sits before the name. The header is align-items:center
             rather than baseline: a 34px circle has no text baseline to sit on, and with
             baseline the names were dragged upward by it.
             11.3.2 — EVERY CELL IS A DIRECT CHILD, ONE PER COLUMN, and the avatar cell is
             emitted even when empty. The columns are #stList's grid and each header is a subgrid of it
             (css/logs.css), so a missing cell would shift every cell after it one column left.
             NO BACKTICKS IN HERE — this comment is inside a template literal, and one closes
             the string. It cost a run to relearn that. -->
        <span class="caret">▸</span>${stFaceFor(n, e)}<b class="stName">${esc(e.name || n)}</b><span><span class="stVoiceTxt" id="${pre}VoiceTxt" title="This character's voice. Open the row to change it."></span></span><span class="small muted stCell">${e.avatar ? `<span title="SillyTavern's own file for this character. Shown because a name is not unique — two characters can share one, and this is what tells them apart.">${esc(e.avatar)}</span>` : ''}</span><span class="small muted stCell cacheStats" id="${pre}HeadStats" title="This character's cached messages and the disk space they use. Open the row to clear them."></span><span class="small muted stCell">seen ${esc(e.last_seen || '—')}</span><span></span>
        <button class="danger sm stDel" title="Remove this character (takes effect on Save)">🗑</button>
      </div>
      <div class="stBody">${voiceClusterHTML(clusterIds(pre))}</div>
    </div>`;
}
// ── 11.3.0: the Voice cache table (below the Save row) ───────────────────────────────────────
// This table shows every voice's cached-message count and size, with a clear action per row.
// Character rows show the same numbers one voice at a time. Markup:
// partials/panel-sillytavern-voicecache.html.
//
// Every voice, its cached message count and size, sortable, with a 🧹 Clear per row. Numbers come
// from ui/audition.js's one /voices/cache_stats fetch (`onCacheStats`), the same one the per-row
// fields use, so the table and the fields can never disagree.
//
// 📌 COLUMN LAYOUT (11.3.1/11.3.2). An empty `width:100%` cell before the button takes the slack,
// leaving the voice column auto-sized and the other columns beside it.
//
// ⚠️ IT REPAINTS EVERY 30 s, SO IT IS NOT REBUILT EVERY 30 s. When the row ORDER is unchanged the
// cells are rewritten in place and the buttons stay the same elements — a rebuild under the
// pointer eats the click that was on its way to a Clear button. Only a new order (a sort click, a
// count that overtakes another, a voice added) rebuilds the body.
const stCache = { sort: 'bytes', dir: -1, order: '' };
/** @type {Record<string, {messages: number, bytes: number}> | null} */
let stCacheStats = null;
/** @param {string} k */
const stCacheArrow = k => (stCache.sort === k ? (stCache.dir > 0 ? ' ▲' : ' ▼') : '');
function stRenderCacheTable() {
  const box = $('stCacheTable');
  if (!box) return;
  const S = stCacheStats || {};
  const rows = stVoiceOpts.map(v => ({ v, label: v.label || v.name, ...(S[v.name] || { messages: 0, bytes: 0 }) }));
  const k = stCache.sort;
  rows.sort((a, b) => {
    const d =
      k === 'label'
        ? a.label.localeCompare(b.label, undefined, { sensitivity: 'accent' })
        : k === 'messages'
          ? a.messages - b.messages
          : a.bytes - b.bytes;
    return d * stCache.dir || a.label.localeCompare(b.label);
  });
  const order = `${k}|${stCache.dir}|` + rows.map(r => r.v.name).join('\n');
  const cells = () =>
    rows.forEach(r => {
      const tr = box.querySelector(`tr[data-voice="${CSS.escape(r.v.name)}"]`);
      if (!tr) return;
      /** @type {HTMLElement} */ (tr.querySelector('.stcMsgs')).textContent = stCacheStats ? r.messages.toLocaleString() : '—';
      /** @type {HTMLElement} */ (tr.querySelector('.stcSize')).textContent = stCacheStats ? fmtCacheBytes(r.bytes) : '—';
    });
  if (order === stCache.order && box.querySelector('table')) return cells();
  stCache.order = order;
  if (!rows.length) {
    box.innerHTML = '<span class="muted">No voices yet.</span>';
    return;
  }
  const tip = 'Click to sort (click again to flip)';
  box.innerHTML =
    `<table class="pgtable"><thead><tr>
      <th data-sort="label" title="${tip}">Voice${stCacheArrow('label')}</th>
      <th data-sort="messages" title="${tip}" style="text-align:right">Cached messages${stCacheArrow('messages')}</th>
      <th data-sort="bytes" title="${tip}" style="text-align:right">Size${stCacheArrow('bytes')}</th><th style="width:100%"></th><th></th></tr></thead><tbody>` +
    rows
      .map(
        r => `<tr data-voice="${esc(r.v.name)}">
      <td style="white-space:nowrap">${esc(voiceOptText(r.v))}</td>
      <td class="stcMsgs" style="text-align:right;white-space:nowrap"></td>
      <td class="stcSize" style="text-align:right;white-space:nowrap"></td><td></td>
      <td style="white-space:nowrap"><button class="sm stcClear" style="background:#f5e6a3;border-color:#e3cd77;color:#4a3d0e;font-weight:600;border-radius:999px;white-space:nowrap;padding:4px 14px" title="Delete this voice's cached messages — they render fresh the next time they play">🧹 Clear cached messages</button></td></tr>`,
      )
      .join('') +
    '</tbody></table>';
  cells();
}
/** @type {VEl} */ ($('stCacheTable')).addEventListener('click', e => {
  const t = /** @type {HTMLElement} */ (e.target);
  const th = /** @type {HTMLElement|null} */ (t.closest('th[data-sort]'));
  if (th) {
    const k = /** @type {string} */ (th.dataset.sort);
    // A number column starts biggest-first, the name column A-Z: the first click on a column
    // should answer the question it is asking.
    stCache.dir = stCache.sort === k ? -stCache.dir : k === 'label' ? 1 : -1;
    stCache.sort = k;
    stRenderCacheTable();
    return;
  }
  const btn = /** @type {HTMLButtonElement|null} */ (t.closest('.stcClear'));
  if (!btn) return;
  const v = /** @type {string} */ (/** @type {HTMLElement} */ (btn.closest('tr')).dataset.voice);
  clearVoiceCache(v, voiceLabelOf(stVoiceOpts, v), btn);
});
onCacheStats(s => {
  stCacheStats = s;
  stRenderCacheTable();
  stPaintHeadStats();
});
// 11.3.2 — each character's cache in its header, between the avatar file and the seen date.
// Painted from the same fetch as everything else; blank until the first one lands.
function stPaintHeadStats() {
  /** @type {NodeListOf<StRowEl>} */ (document.querySelectorAll('#stList .stRow')).forEach(r => {
    const el = $(r.dataset.pre + 'HeadStats');
    const s = speakerCacheStats('st', r.dataset.name);
    if (!el) return;
    el.textContent = s ? `${s.messages.toLocaleString()} cached msgs – ` : '';
    if (!s) return;
    // The size is the number to scan for, so it is bold in the full text color against the muted
    // rest of the cell.
    const b = document.createElement('b');
    b.className = 'stCacheSize';
    b.textContent = fmtCacheBytes(s.bytes);
    el.appendChild(b);
  });
}

// Names whose rows are open. A full re-render (↻ Refresh list, ↺ Reset, Save) rebuilds every row,
// and snapping the row being edited shut would interrupt the edit.
const stOpen = new Set();
/**
 * The header's read-only voice: the select's own option text (so the ⭐ and the display label
 * match the dropdown exactly), or for an unassigned row the default voice it will speak with —
 * read from the default dropdown NOW, not from the "(use default voice — X)" option, whose X was
 * fixed when the row was built.
 * @param {string} pre
 */
function stPaintVoiceTxt(pre) {
  const out = $(pre + 'VoiceTxt'),
    sel = /** @type {HTMLSelectElement|null} */ ($(pre + 'Voice'));
  if (!out || !sel) return;
  if (sel.value) {
    const o = sel.options[sel.selectedIndex];
    out.textContent = o ? o.text : sel.value;
    out.classList.remove('muted');
    return;
  }
  const def = /** @type {HTMLSelectElement|null} */ ($('stDefVoice'));
  const d = def && def.value ? def.options[def.selectedIndex] : null;
  out.textContent = d ? `Default voice (${d.text})` : 'Default voice (none set)';
  out.classList.add('muted');
}
/**
 * @param {StRowEl} r
 * @param {StCharEntry} [e]
 */
function wireStRow(r, e) {
  const pre = r.dataset.pre,
    f = stF(pre),
    selId = pre + 'Voice';
  e = e || {};
  /** @type {VEl} */ ($(selId)).innerHTML = voiceOptionsHTML(stVoiceOpts, e.voice || '', useDefaultLabel(stVoiceOpts, stLast.def));
  // `String(...)`: an input's `.value` is a string; the runtime was already coercing this
  // (same note as `ui/theme.js`'s `uiFontApply` and `st/nomi.js`'s `appendNomiRow`).
  /** @type {HTMLInputElement} */ ($(f.exag)).value = String(e.exaggeration != null ? e.exaggeration : 0.5);
  /** @type {HTMLInputElement} */ ($(f.cfg)).value = String(e.cfg != null ? e.cfg : 0.5);
  /** @type {HTMLInputElement} */ ($(f.temp)).value = String(e.temperature != null ? e.temperature : 0.8);
  // Rows edit PER-CHARACTER params (settings belong to the character, not
  // the voice), so a voice change deliberately does NOT reload the knobs.
  /** @type {VEl} */ ($(pre + 'Prev')).onclick = () => stepVoice(selId, -1);
  /** @type {VEl} */ ($(pre + 'Next')).onclick = () => stepVoice(selId, 1);
  for (const k of /** @type {('exag'|'cfg'|'temp')[]} */ (['exag', 'cfg', 'temp']))
    for (const ev of ['input', 'change']) /** @type {VEl} */ ($(f[k])).addEventListener(ev, () => updateAudition(f, selId, pre + 'AudOut'));
  /** @type {VEl} */ ($(selId)).addEventListener('change', () => updateAudition(f, selId, pre + 'AudOut', true));
  // Audition = the SAME clip flow as Book/Playground/Nomi (visible player,
  // lands in the library, steppers replay it). It renders the ON-SCREEN
  // values but persists nothing — per-character settings only change on the
  // green Save. (Real streaming is exercised by actual ST narration.)
  /** @type {VEl} */ ($(pre + 'Aud')).onclick = () =>
    runAudition(
      /** @type {HTMLSelectElement} */ ($(selId)).value,
      curParams(f),
      /** @type {import('../ui/audition.js').AuditionBtn} */ ($(pre + 'Aud')),
      /** @type {VEl} */ ($(pre + 'AudOut')),
    );
  // 11.3.0 — this character's own cache, not the voice's: the field counts it and 🧹 clears it.
  wireClearCache(
    pre,
    selId,
    () => stLast.def,
    () => stVoiceOpts,
    () => ({ kind: 'st', key: r.dataset.name, label: e.name || r.dataset.name }),
  );
  updateAudition(f, selId, pre + 'AudOut'); // a matching audition clip plays free
  stPaintVoiceTxt(pre);
  /** @type {VEl} */ ($(selId)).addEventListener('change', () => stPaintVoiceTxt(pre));
  /** @type {HTMLElement} */ (r.querySelector('.stHead')).onclick = () => {
    const open = r.classList.toggle('open');
    if (open) stOpen.add(r.dataset.name);
    else stOpen.delete(r.dataset.name);
  };
  /** @type {HTMLButtonElement} */ (r.querySelector('.stDel')).onclick = ev => {
    ev.stopPropagation(); // the 🗑 sits in the header; deleting must not also toggle the row
    stOpen.delete(r.dataset.name);
    stRemoved.add(r.dataset.name);
    r.remove();
    stCheckDirty();
  };
}
/**
 * @param {Record<string, StCharEntry>} chars
 * @param {string} [defVoice]
 */
function renderStChars(chars, defVoice) {
  stLast = { chars, def: defVoice || '' };
  stRemoved.clear(); // a full render restores every row, the deleted ones included
  // the default-voice cluster renders even with an empty character list — its
  // knobs are audition-only (unassigned characters speak the default voice at
  // the chatterbox defaults); the dropdown saves via Save
  /** @type {VEl} */ ($('stDefaultCluster')).innerHTML = voiceClusterHTML(clusterIds('stDef'));
  wireAudCluster(
    'stDef',
    defVoice || '',
    sel => voiceOptionsHTML(stVoiceOpts, sel, UNSET_DEFAULT_LABEL),
    null,
    () => stVoiceOpts,
  );
  // Unassigned rows name the default voice in their header, so a new default renames them all.
  /** @type {VEl} */ ($('stDefVoice')).addEventListener('change', () =>
    /** @type {NodeListOf<StRowEl>} */ (document.querySelectorAll('#stList .stRow')).forEach(r => stPaintVoiceTxt(r.dataset.pre)),
  );
  stRenderCacheTable();
  const names = Object.keys(chars).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    /** @type {VEl} */ ($('stList')).innerHTML = ST_EMPTY_HTML;
    stBaseline = JSON.stringify(stCollect());
    stSetDirty(false);
    return;
  }
  stSeq = 0;
  /** @type {VEl} */ ($('stList')).innerHTML = names.map(n => stRowHTML(n, chars[n])).join('');
  /** @type {NodeListOf<StRowEl>} */ (document.querySelectorAll('#stList .stRow')).forEach(r => wireStRow(r, chars[r.dataset.name]));
  stBaseline = JSON.stringify(stCollect());
  stSetDirty(false);
}
// ── live refresh: a character that appears while you're sitting on this tab ──
// SillyTavern registers a character server-side the moment a chat opens, and
// every narration re-registers, so a tab left open here polls GET /st/characters
// and INSERTS any name not already on screen — in alphabetical position, so the
// list stays sorted. INSERT-ONLY on purpose: an existing row is never
// re-rendered, so an unsaved edit in a row you're working on is never clobbered,
// and a row you deleted (pending Save) is not resurrected on the next tick.
/** @type {ReturnType<typeof setInterval>|null} */
let stPollTimer = null;
/**
 * @param {string} name
 * @param {StCharEntry} [e]
 * @returns {Element|undefined}
 */
function stInsertRow(name, e) {
  // Clear the "No characters yet" placeholder — tested by the ABSENCE OF ROWS, never by
  // hunting for a .muted node: every row carries its own `seen <date>` muted span, so that
  // search hits row 1 on the second insert and blows the whole list away.
  const list = /** @type {VEl} */ ($('stList'));
  if (!list.querySelector('.stRow')) list.innerHTML = '';
  const after = [.../** @type {NodeListOf<StRowEl>} */ (list.querySelectorAll('.stRow'))].find(x => x.dataset.name.localeCompare(name) > 0),
    html = stRowHTML(name, e);
  if (after) after.insertAdjacentHTML('beforebegin', html);
  else list.insertAdjacentHTML('beforeend', html);
  const row = [.../** @type {NodeListOf<StRowEl>} */ (list.querySelectorAll('.stRow'))].find(x => x.dataset.name === name);
  wireStRow(/** @type {StRowEl} */ (row), e);
  return row;
}
// Save lights up only when the tab DIFFERS from what was loaded, so an inserted
// row has to land in the BASELINE too — at its server values, and in DOM order,
// since the baseline is a JSON string of stCollect() and its key order is DOM
// order. Existing rows keep their old baseline entries, so an untouched tab
// stays clean and an edit in progress stays dirty.
function stRebase() {
  const live = stCollect();
  let base;
  try {
    base = JSON.parse(stBaseline);
  } catch (e) {
    base = null;
  }
  if (!base || !base.characters) {
    stBaseline = JSON.stringify(live);
    return stCheckDirty();
  }
  /** @type {Record<string, StCharEntry>} */
  const chars = {};
  Object.keys(live.characters).forEach(n => {
    chars[n] = base.characters[n] || live.characters[n];
  });
  stBaseline = JSON.stringify({ characters: chars, default_voice: base.default_voice || '' });
  stCheckDirty();
}
async function pollStNew() {
  if (document.hidden) return;
  let r;
  try {
    r = await jget('/st/characters');
  } catch (e) {
    return;
  } // silent; ↻ and tab-open surface errors
  stVoiceOpts = r.voice_options || stVoiceOpts; // keep newly-added voices selectable
  const chars = r.characters || {},
    have = new Set([.../** @type {NodeListOf<StRowEl>} */ (document.querySelectorAll('#stList .stRow'))].map(x => x.dataset.name)),
    fresh = Object.keys(chars)
      .filter(n => n && !have.has(n) && !stRemoved.has(n))
      .sort((a, b) => a.localeCompare(b));
  if (!fresh.length) return;
  // m4h / §9a.2 — a character appearing here has just started a chat in SillyTavern, which is
  // also when a sweep is most likely to have just brought its card in. Re-read the faces before
  // building the row, or the one row that most deserves a picture is the one that gets a letter.
  // ⚠️ Only on the branch that has work to do — this poll runs every 4 s.
  await stLoadFaces();
  // stLast is what ↺ Reset re-renders — a character that popped in must survive it
  fresh.forEach(n => {
    stLast.chars[n] = chars[n];
    stInsertRow(n, chars[n]);
  });
  stRebase();
}
function stPollStart() {
  stPollStop();
  stPollTimer = setInterval(pollStNew, 4000);
}
export function stPollStop() {
  if (stPollTimer) {
    clearInterval(stPollTimer);
    stPollTimer = null;
  }
}
// 🔴 A FIFTH EXPORT, AND IT IS THE ONLY LINE IN THIS FILE THAT IS NOT A VERBATIM MOVE.
// `tests/st_characters_live_spec.mjs` asserts the poll's scope at six points — the Logs sub-tab
// stops it, coming back restarts it, leaving the ST tab stops it, and leaving DURING the load's
// GET does not strand one behind you — and every one of them read `stPollTimer` off the page.
// It is private now, so all six threw `ReferenceError` the moment this module landed. §6 step 9
// is why that was a spec failure and not a shipped regression.
//
// ⚠️ PUBLISHING THE `let` INSTEAD WOULD HAVE BEEN WORSE THAN THE BREAKAGE. `Object.assign(window,
// mod)` copies the value ONCE, at load, when the timer is null — so `stPollTimer === null` would
// pass forever, `stPollTimer !== null` could never pass, and the three checks that matter most
// (the two stops and the mid-load race) would report success against a value nothing updates.
// Landmine §11.4 in one sentence. A function reads the live binding through its own closure.
export function stPollRunning() {
  return stPollTimer !== null;
}
// ⚠️ AND A SIXTH, FOR THE SAME REASON AND THE SAME SPEC. wbedit_browser_spec.mjs asserts that an
// ambiguous name was SEEN rather than missed — `Object.keys(stFaces.byName)` must contain `twin`
// with a null beside it — which is a read of the real map after a real load, so the `faces`
// parameter above cannot serve it. A getter can: it returns the current object every call, so it
// tracks `stLoadFaces`'s reassignment where a shim-copied `let` would be frozen at the seed value.
export function stFacesNow() {
  return stFaces;
}
// Switching back to this browser tab -> refresh immediately instead of waiting the interval out.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && stPollTimer) pollStNew();
});
async function saveStChars() {
  const out = stCollect(); // {characters, default_voice}
  try {
    const resp = await fetch('/st/characters', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out),
    });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || resp.statusText);
    /** @type {VEl} */ ($('stSave')).textContent = 'Saved ✓';
    setTimeout(() => {
      /** @type {VEl} */ ($('stSave')).textContent = 'Save';
    }, 1200);
    loadStChars();
  } catch (e) {
    await modal('Save failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  }
}
/** @type {VEl} */ ($('stRefresh')).onclick = loadStChars;
/** @type {VEl} */ ($('stSave')).onclick = saveStChars;
