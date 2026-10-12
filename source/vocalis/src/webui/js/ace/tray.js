// ace/tray.js — the candidates tray and the song library (8.0-m3h, §4.5.3).
//
// Two lists, and the difference between them is the whole model:
//
//   CANDIDATES  what this session generated. Transient, living on the ACE-Step box, proxied for
//               playback. Save promotes one; Discard drops it. Most are discarded — that is what
//               the tray is FOR.
//   LIBRARY     what you kept. Vocalis's own, in the vault, with a proper name. Filtered to the
//               selected template by default, because a template's songs are what you want to
//               compare when you are working on that song.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// Queued work can be removed exactly because it has not reached ACE-Step. Cancel on submitted
// work stops result collection, while Stop or Unload terminates that card's owned child.
//
// ⚠️ POLLING IS 2 s AND ONLY WHILE THE TAB IS VISIBLE. A song is minutes long, so this is not
// latency-sensitive; and /acestep/jobs walks the job registry, so polling it from a hidden tab
// would cost the server for nothing.

import { reconcile } from '../ui/reconcile.js';
// 8.9 — virtual folders. Scope `acelib`: the saved-song library. 📌 Its key is the uuid4 `id`
// assigned once at save, and the rename route writes only `name` — so this scope is NOT in
// `folders.RENAME_MOVES_REF` and has nothing a future rename path could forget.
import {
  folderRows,
  folderBar,
  folderGap,
  folderPage,
  folderReconcileRows,
  folderWire,
  folderWireDrag,
  folderDragging,
  folderAddButton,
  loadFolders,
} from '../ui/folders.js';
import { $, esc } from '../util/dom.js';
import { fmtSeed } from '../util/fmt.js';
import { jget, jpost, jdel } from '../util/http.js';
// 9.7.0 — the shared filter. `filtWire` for this box lives in ui/filterwiring.js like the other
// ten, NOT here: that file is the sink that names every box on the page, and the one box wired
// somewhere else is the one that was silently dead for the whole life of its panel.
import { filtQ, filtRows, filtNone, filtCount } from '../util/filter.js';
// promptForName rather than a second one-field dialog: its own header says it was
// extracted so a copy could not drift, and 'the copy that drifts is the one that stops
// closing on Escape'.
import { modal, promptForName } from '../ui/modal.js';
// 🔴 UIS, NOT localStorage — see below. The store lives server-side, in the vault.
import { UIS } from '../util/uistate.js';
// m25 — the 🎤 on a library row. No cycle: media/voiceswap.js imports nothing from ace/.
// 8.9.6 - the tray subscribes to the header button's status poll. No cycle: sys/acestep.js
// imports util/, ui/modal and sys/hwstrip only, and ace/cards.js already subscribes this way.
import { onAceStatus } from '../sys/acestep.js';
// 8.1-m3 §7 — the row action prefills the card. No cycle: ace/form.js imports
// nothing from ace/tray.js.
import { prefillFromSource } from './form.js';

// ── 🔴 TYPES FOR THE TWO POLLED LISTS THIS FILE READS (8.3-m2) ─────────────────────────────────
// Named off the fields actually read below, not off the Flask routes' full response.
/** One ACE-Step job row; rendered values correspond to the planner response.
 * * @typedef {object} AceJob
 * @property {string} id
 * @property {string} status - 'queued' · 'running' · 'done' · 'failed', or another the server
 *   hasn't named yet — the fallback branch in candidateRow renders whatever string arrives.
 * @property {string} [device]
 * @property {string} [model]
 * @property {string} [title]
 * @property {number} [queue_position]
 * @property {number} [started_at]
 * @property {number|string} [seed]
 * @property {string} [error]
 * @property {{caption?: string, lyrics?: string}} [rendered]
 */
/** Response envelope for `/acestep/jobs`.
 * * @typedef {object} AceJobsResponse
 * @property {AceJob[]} [jobs]
 * @property {number} [now] - server clock, seconds — see NOW_SKEW below.
 * @property {{on?: boolean}} [forever]
 * @property {string[]} [ids] - `/acestep/candidates/discard_all`'s response reuses this shape.
 * @property {number} [undoable] - how many candidates ↩ Undo discard would put back. On this
 *   poll rather than its own route, for the reason `forever` is: the recycle bin is on DISK and
 *   survives a reload, so a tray counting its own discards reads 0 on a fresh page with a song
 *   still recoverable — the store remembering while the button forgets.
 */
/** One saved ACE-Step library song.
 * * @typedef {object} AceLibrarySong
 * @property {string} id
 * @property {string} name
 * @property {boolean} [favorite]
 * @property {string} [model]
 * @property {number|string} [seed]
 * @property {number} [created_at] - unix seconds, stamped once at save. 9.7.0 — this was on the
 *   payload from the start (`Song.to_dict`) and simply not declared, because nothing read it: the
 *   server sends the list newest-first and the panel painted it in that order. The Newest / Oldest
 *   orders read it directly, so it is named here now.
 * @property {Record<string, unknown>} [template] - the template it was made from, or a plain
 *   object for rows saved before 8.0-m9 (see ace/form.js's `ace:loadsong` handler).
 * @property {string} [lyrics]
 * @property {string} [caption]
 * @property {{caption?: string, lyrics?: string}} [rendered]
 * @property {string|null} [folder] - 8.9: the id of the virtual folder this song is filed in, or
 *   absent/null for unfiled. Stamped by the server (`folders.for_rows`, scope `acelib`, keyed on
 *   `id`). 📌 Stamped even when `?template_id=` narrows the list: a filtered VIEW must not change
 *   what a row IS, or filing a song under one template would appear to unfile it under another.
 */
/**
 * `/acestep/library`'s envelope.
 * @typedef {object} AceLibraryResponse
 * @property {AceLibrarySong[]} [songs]
 */

/** @type {ReturnType<typeof setInterval>|null} */
let TIMER = null;
/** @type {string|null} */
let TEMPLATE = null; // the picker's current template, for the library filter
let DL_FORMAT = 'flac'; // §4.5.4 — remembered between downloads
let NOW_SKEW = 0; // serverNow - clientNow, from /acestep/jobs (see elapsed)
/** @type {AceLibrarySong[]} */
let SONGS = []; // the last library payload, so a click has the whole song to hand
// 8.1-m3 §7: the same trick for candidates. A row action needs the job's WORDS, and re-fetching
// /acestep/jobs to answer a click the poll already has the answer to would be a round trip for
// nothing — SONGS has done exactly this for the library since 8.0.
/** @type {AceJob[]} */
let JOBS = [];
//: 🔴 ONE LIST, READ BY BOTH BRANCHES. The candidate rows and the library rows offer the same
//: actions, and two hand-written `act === …` chains is how one of them silently stops covering a
//: mode that was added to the other — the same failure the FIELDS table in ace/form.js exists to
//: prevent. Every entry here must be an `id` in that file's MODES.
const SOURCE_ACTS = new Set(['remix', 'repaint', 'extract', 'lego', 'complete', 'edit', 'retake']);
/** @type {string|null} */
let EXPANDED = null; // the library song whose lyrics are open, or null

// 🔴 THIS WAS RAW localStorage AND IT COULD NOT WORK. UIS migrates every `vocalis-*` key off
// the client on boot — it copies the value into the server-side store and then REMOVES the
// local key — so a direct read here returned null on the next load and fell back to
// flac.
// ⚠️ The file's own header already said why templates are a store rather than localStorage.
// This line was the one place in the tab that had not been told.
DL_FORMAT = UIS.getItem('vocalis-ace-dl') || 'flac';

// Which row is open is a thing the user picked, so it survives a bounce like everything else in
// this panel. ⚠️ Restoring it re-opens the LYRICS only — it must not re-fire `ace:loadsong`,
// because the form's own draft has already been restored by then and re-loading the song over it
// would discard whatever was typed since. Opening a box shows; clicking a row loads.
const EXPANDED_KEY = 'vocalis-ace-open';
EXPANDED = UIS.getItem(EXPANDED_KEY) || null;

// ── 🔴 AUTOPLAY: WHEN A CANDIDATE LEAVES, PLAY THE NEXT ONE ───────────────────────────────
// A remembered checkbox controls whether saving or discarding a candidate plays the next row;
// when none follows, playback wraps to the top of the list.
//
// 🔴 IT FIRES WHEN THE ROW GOES, NOT WHEN THE BUTTON IS PRESSED. Choose the successor before
// changing the list, but play it only after the save/discard succeeds; cancel leaves playback alone.
//
// 📌 Persisted through UIS like every other choice in this tab, so it survives a bounce.
const AUTOPLAY_KEY = 'vocalis-ace-autoplay';
let AUTOPLAY = UIS.getItem(AUTOPLAY_KEY) === '1';

// ── 🔴 THE LIBRARY GETS A FILTER, AN ORDER AND PAGES (9.7.0) ──────────────────────────────
//
// The library provides sorting, filtering, and paging over the complete song list.
//
// 🔴 ALL THREE ARE DISPLAY-ONLY, AND THE SERVER IS NOT TOLD ABOUT ANY OF THEM. `/acestep/library`
// still answers the whole list newest-first; SONGS is still the whole payload; a click on any row
// still resolves out of SONGS. That is what lets the player at the top of the list keep playing
// while you type a filter that excludes the very song it is playing — the rule `util/filter.js`
// has stated for nine panels since 7.3-m1b, and this panel has an <audio> in every row.
//
// 🔴 AND NONE OF THEM REFETCHES. The three controls repaint from the payload already in hand
// (`aceLibRender`), never `refreshAce` — filterwiring.js's own header says a filter box wired to
// the LOADER puts an HTTP round trip on every keystroke. The 2 s poll is the only fetch here and
// it is unchanged; it calls the same painter when its data lands.
//
// ⚠️ A DROP-DOWN, NOT CLICKABLE HEADERS, and the Voice Swap library records why: these rows are
// cards, not a `<table>`, so there is no `<th>` to click. `vsLibSort` is the same control with the
// same four-way shape, and this follows it rather than inventing a second idiom for one panel.
// 🔴 THE BOX ID IS WRITTEN OUT AT EVERY `filt*` CALL, NEVER HELD IN A CONSTANT, AND THAT IS A
// TEST TALKING. `test_filter_boxes_are_wired.py` censuses the tree for `filtQ('id')` against
// `filtWire('id')` in BOTH directions — a box read but never wired filters nothing for ever
// (`spFilter`, dead for the whole life of its panel), and a box wired but never read is a
// keystroke handler repainting a list that ignores the query. Its regex reads STRING LITERALS,
// so `filtQ(LIB_FILTER)` is invisible to it: the first cut of this panel used a constant and the
// census reported `aceLibFilter` as wired-but-unread — correctly, as far as it could see. All ten
// other boxes pass the literal; the constant was a private tidiness that cost a real guard its
// sight. If this ever needs a name again, teach the census first.
const LIB_SORT_KEY = 'vocalis-ace-libsort';
const LIB_SORTS = ['new', 'old', 'name', 'namez'];
let LIB_SORT = 'new';
try {
  const s = UIS.getItem(LIB_SORT_KEY);
  // Narrows rather than asserts: `UIS.getItem` answers `string | null` and null is the ordinary
  // first run, while an order that is no longer offered must fall back instead of being cast into
  // existence. Same three lines, and the same reasoning, as `VS_LIBSORT` in media/swaplib.js.
  if (s && LIB_SORTS.includes(s)) LIB_SORT = s;
} catch (e) {}
// 🔴 PER PAGE, AND IT IS 25 BECAUSE EVERY ROW HOLDS AN `<audio>`. The Playground table pages at
// 20 and the Sources picker at 25; the number matters more here than in either, because each row
// carries a media element with `preload="metadata"` — a library of 400 songs rendered flat is 400
// range requests against the vault on one paint, in addition to the scrolling cost.
const LIB_PER = 25;
let LIB_PAGE = 0;
// 🔴 EVERY SONG THE FILTER IS SHOWING, ACROSS ALL PAGES — written by the render, read by
// `All` and by 🗑 Delete selected. The Sources picker keeps the same list for the same reason
// (`vsSrcShown`): a Select all that could only reach the visible page would make a 200-song
// clear-out twenty gestures, and recomputing the slice in the handler is the second copy of the
// paging arithmetic that folders made WRONG rather than merely duplicated over in playground.js.
/** @type {string[]} */
let LIB_SHOWN = [];
//: How many pages the last render produced, so the bar can repaint itself on a tick without
//: re-running the whole partition. Written by `aceLibRender`, read by `paintLibBar`.
let LIB_PAGES = 1;

// ── the two lists' markup, painted here for the same reason the form's is ──────────────────
// index.html is under a line ceiling that has gone 11,100 -> 2,800 -> 2,000 and has never once
// gone up; when a new panel does not fit, test_webui_size.py says the answer is another
// extraction rather than another constant. So the panel holds one empty <div> and this fills it.
//
// ⚠️ PAINTED AT MODULE LOAD, LIKE ace/form.js. The click handler below is delegated off
// `document`, so it would survive a late paint — but `startAceTray`'s first `refreshAce()` writes
// into #aceTray and #aceLibrary, and those have to exist by then.
const TRAY_HTML = `
<!-- 🔴 CLEAR QUEUE SITS ON THE HEADING, NOT UNDER THE LIST. The queued rows are at the TOP of
     the tray, so the control
     that clears them belongs where they are, not past everything they are not. -->
<div class="row" style="margin:14px 0 4px;align-items:baseline;gap:12px">
  <h3 style="flex:0;margin:0">Candidates</h3>
  <div id="aceQueueBar" style="flex:1;display:none;align-items:baseline;gap:10px">
    <button id="aceClearQ" class="xs danger" style="flex:0">Clear queue</button>
    <span id="aceQueueWhat" class="small muted" style="flex:1"></span>
  </div>
</div>
<!-- 🔴 AUTOPLAY BELONGS TO THE LIST, SO IT SITS ON THE LIST'S HEADER LINE. It shipped inside each
     finished row's action cell first, and
     the cost was not only that it looked wrong: one tick per row made the finished rows two lines
     tall while the queued ones stayed one, making the tray's alignment ragged. One control, one
     place, and the rows stay a constant height. -->
<div class="row" style="margin-bottom:6px;align-items:baseline;gap:12px">
  <div class="small muted" style="flex:1">One per card, from the last Generate. Play them, keep the one you want — the rest are never written anywhere.</div>
  <!-- Discard all affects finished candidates only; submitted and queued work are separate.
       ⚠️ Hidden while the tray holds nothing finished — a permanently visible destructive control
       over an empty list is the Unload-on-an-empty-card mistake, twice corrected already. -->
  <button id="aceDiscardAll" class="xs danger" style="flex:0;display:none" title="Discard every finished candidate. Submitted renders are untouched; use Stop or Unload on their card to terminate its child. Anything queued belongs to Clear queue below.">✕ Discard all</button>
  <!-- ↩ UNDO DISCARD — one slot, and it holds whatever the LAST discard removed (8.9.10).
       The most recent discard can be restored across restarts.
       ⚠️ Hidden when the bin is empty, for the same reason Discard all is hidden over an empty
       list: a control that cannot do anything still invites the press that finds that out. -->
  <button id="aceUndoDiscard" class="xs" style="flex:0;display:none" title="Put the last discard back. One level — this catches an accident, it is not a history. The audio was never deleted, so a restored candidate plays again.">↩ Undo discard</button>
  <label class="chk small" style="flex:0;white-space:nowrap" title="When a candidate leaves this list — saved or discarded — start playing the next one down. Wraps to the top when the one you dealt with was last."><input type="checkbox" id="aceAutoplay"> Autoplay</label>
</div>
<!-- 🔴 THE BANNER SITS ABOVE THE ROWS IT EXPLAINS, and it is empty on every ordinary
     day. See paintDead() below for why it exists at all: a stopped backend makes every
     candidate here unplayable at once, and what that LOOKS like is a column of dead
     controls and not one word of explanation. -->
<div id="aceTrayDead" class="small" style="display:none;margin:0 0 8px;padding:8px 10px;border-radius:6px;border:1px solid #7a5c1a;background:#2a2413"></div>
<div id="aceTray"><div class="small muted">No candidates yet — press Generate.</div></div>
<!-- Clear queue removes unsent work only. Submitted work remains reserved until a terminal result
     or confirmed child exit; Stop and Unload terminate the selected card's owned child. -->

<!-- 🔴 THE FORMAT PICKER SITS IN THE GRID, DIRECTLY OVER THE DOWNLOAD BUTTON.
     §4.5.4 put it beside the songs rather than in the settings pane, because it is a per-download
     choice you make while looking at the thing you are downloading — it belongs beside the
     control it governs.
     Being INSIDE the library grid is what keeps it in the same COLUMN as the control it governs:
     this is a header row of the same grid, so its fourth cell is the same track as the actions.
     ⚠️ BUT IT IS NO LONGER THE SAME LEFT EDGE, AND THAT WAS PAID FOR RATHER THAN LOST (9.0.12).
     Two invisible buttons used to stand in for the ★ and ✎ that were the only controls before
     Download, which put the picker's left edge exactly on Download's. The row has grown to TEN
     buttons since, so those stand-ins lined it up with nothing — and mirroring all ten would make
     this header the widest cell in an auto-sized track and charge every song row ~100px of dead
     space for it, which is the defect fixed in the same commit. The picker takes margin-left:auto
     instead and sits over the Download / ✕ cluster at the row's right edge. See .acedlpick.
     NOTE no backticks in this comment - one would end the template literal.
     🔴 AND THE HEADING MOVED IN HERE WITH IT (8.0.1b), WHICH IS WHAT STOPS IT COSTING A LINE.
     It was: a flex heading row, then a grid header row holding nothing but the picker, i.e. two
     lines to say one thing. Moving the picker up onto the
     heading — and that would undo the paragraph above, because the heading is a different
     container and cannot line up with a grid track. So the heading came DOWN instead. One line,
     the picker still in the actions column, both instructions kept.
     The title and its blurb share cells 1-3 as one flex box, which is exactly what the old
     row was; baseline alignment is preserved on it because the cell default here is center and
     these are two different type sizes.
     The data-keep attribute is what stops the 2 s reconcile from sweeping this away as a row
     with no id. NOTE no backticks in this comment - one would end the template literal. -->
<div id="aceLibrary"><div class="acesong acedlhead" data-keep><div class="acerow">
  <span class="acedlttl" style="grid-column:1/4;align-items:baseline;gap:10px">
    <h3 style="margin:0">Library</h3>
    <span class="small muted">Songs you kept. Selecting a template above filters this to the songs made from it.</span>
    <!-- 🔴 THE ANCHOR THE LIBRARY-WIDE BUTTONS ARE INSERTED BEFORE, and it is in THIS cell
         rather than beside the Download-as picker on purpose. The picker's cell is the grid's
         fourth track, which is auto-sized and therefore takes the width of the widest cell in the
         column - so three toolbar labels parked there made every song row's actions cell ~230px
         wider than its own buttons, and the title and the player (the two fr tracks) funded it.
         See .acelibtools in acestep.css. The span is empty and generates nothing; the buttons
         land inside it at wiring time, in the order they are inserted.
         NOTE no backticks in this comment - one would end the template literal. -->
    <span class="acelibtools"><span id="aceLibTools" hidden></span></span>
  </span>
  <span class="aceacts">
    <span class="acedlpick" id="aceDlPick">Download as
      <label class="chk"><input type="radio" name="aceDl" value="flac"> FLAC</label>
      <label class="chk"><input type="radio" name="aceDl" value="opus"> Opus 192k</label>
    </span>
  </span>
</div></div>
<!-- 🔴 THE FILTER / ORDER / BULK BAR IS ITS OWN ROW, AND IT IS INSIDE THE GRID (9.7.0).
     It cannot go on the heading line above: that cell already carries the title, the blurb and
     three toolbar buttons, and the recorded rule for this header is that it stays ONE line —
     *"that Download as is on the second line down from the library, and that makes no sense"* —
     which a filter box, a sort picker, a count, a tick-all and a delete button would end.
     ⚠️ data-keep, so the 2 s reconcile treats it as FURNITURE and never sweeps it: it carries no
     data-song, and reconcile removes every child that has neither. Furniture is re-inserted at
     the TOP of the host in its existing order, so this stays directly under the heading row.
     ⚠️ It spans all four tracks (.acelibbar in acestep.css). A plain child of this grid would
     land in track 1 and squeeze five controls into the title column.
     NOTE no backticks in this comment - one would end the template literal. -->
<div class="acelibbar" data-keep>
  <!-- 🔴 SELECT ALL IS A REAL TRI-STATE. A checkbox that shows
       indeterminate while SOME are ticked is the only form that can answer "what is selected?"
       and "select everything" with one control, which is what he asked for.
       ⚠️ It reaches every song the FILTER is showing, including the pages you cannot see - see
       aceLibShown. Ticking only the visible page would make a 200-song delete twenty gestures,
       which is the complaint, not the fix. -->
  <label class="chk small" style="flex:0 0 auto;white-space:nowrap"
         title="Tick every song this filter is showing — every page of them, not just this one. Press it again to clear the selection."><input
         type="checkbox" id="aceSelAll"> All</label>
  <input type="search" id="aceLibFilter" class="filter" placeholder="Filter songs…" autocomplete="off" spellcheck="false"
         title="Show only the songs where every word you type appears in the name, the style or the lyrics, in any order. It filters what is on SCREEN — nothing is deleted, and a song playing in the list carries on even when the filter hides its row.">
  <select id="aceLibSort" class="sm" title="The order the songs are listed in. Your choice follows the account, so it survives a reload.">
    <option value="new">Newest first</option>
    <option value="old">Oldest first</option>
    <option value="name">Name A–Z</option>
    <option value="namez">Name Z–A</option>
  </select>
  <span id="aceLibCount" class="small muted" style="flex:0 0 auto;white-space:nowrap"></span>
  <span style="flex:1 1 auto"></span>
  <button class="sm danger" id="aceLibDel" style="flex:0 0 auto" disabled
          title="Delete every ticked song, and its audio, in one go. This cannot be undone.">🗑 Delete selected</button>
</div>
<div class="small muted">Nothing saved yet.</div></div>
<!-- 🔴 THE PAGER IS OUTSIDE #aceLibrary, AND THAT IS FORCED RATHER THAN CHOSEN. Inside, it would
     need data-keep to survive the reconcile — and reconcile re-inserts furniture at the TOP of
     the host, ahead of every row, so a pager marked that way would paint above the list it pages.
     Out here it is nobody's row and sits where a pager belongs.
     NOTE no backticks in this comment - one would end the template literal. -->
<div id="aceLibPager" class="acelibpager"></div>
`;

{
  const host = $('aceTrayHost');
  if (host) {
    host.innerHTML = TRAY_HTML;
    // Reflect the remembered format onto the radios now that they exist.
    applyAutoplay();
    const r = host.querySelector(`input[name="aceDl"][value="${DL_FORMAT}"]`);
    // ⚠️ BOTH the property and the attribute. `.checked` alone is the live state and is what the
    // user sees — but it does not serialize, so a DOM-dump spec reads the page as having no format
    // selected and cannot tell that from the real bug. `setAttribute` is also the honest way to
    // say "this is the default selection" in markup.
    if (r) {
      /** @type {HTMLInputElement} */ (r).checked = true;
      r.setAttribute('checked', '');
    }
    // 🔴 THE CONTROL MUST SHOW THE ORDER IT IS ACTUALLY USING. Same line, and the same reason, as
    // `vsLibSort` and `vSort`: the value is restored from UIS above, so a picker left on its
    // markup default would say "Newest first" over a list sorted A–Z, every reload.
    // ⚠️ BOTH the property and the attribute, exactly like the radios: `.value` is the live state
    // and does not serialize, so a DOM-dump check reads the select as unset and cannot tell that
    // from the bug.
    const sel = /** @type {HTMLSelectElement|null} */ (host.querySelector('#aceLibSort'));
    if (sel) {
      sel.value = LIB_SORT;
      for (const o of /** @type {HTMLOptionElement[]} */ ([...sel.options])) o.toggleAttribute('selected', o.value === LIB_SORT);
    }
  }
}

// ── 🔴 A DEAD PLAYER MUST SAY WHY IT IS DEAD ────────────────────────────
//
// A candidate's bytes are not on this box. `/acestep/jobs/<id>/audio` proxies them from the
// backend that made the song, so when that unit is stopped EVERY candidate in the tray fails at
// the same instant - and what a browser paints for a media element whose source errored is a
// grayed, inert control with no message anywhere on the page. Save fails too, from the same fetch.
//
// Candidate audio is proxied from its backend. When the service is stopped, inert media controls
// can look like missing files; the banner reports the backend state before playback is attempted.
//
// 🔴 IT READS THE POLL THE HEADER BUTTON ALREADY MAKES. `/acestep/status` says which
// backends are up every 4 s and `onAceStatus` already fans that out to ace/cards.js, so this is a
// subscriber - not a second timer, not a new route. Two pollers would let the tab hold two
// opinions about whether a card is running, and the one on screen would be whichever landed last.
//
// ⚠️ SAID BEFORE ANYTHING IS PRESSED, NOT AFTER A FAILURE. Reacting to the media `error`
// event would announce only the rows the browser happened to try, and `preload` is a hint - which
// rows those are is Chrome's business, not ours. The status poll knows without asking the audio.
//
// ⚠️ AND IT NAMES THE CARD RATHER THAN SAYING "SOMETHING IS WRONG". One backend down and one
// up is a real state: half the tray plays and half does not, and "some of these will not play"
// with no card named is the kind of message that sends someone looking at the wrong thing.

/** @type {AceStatus|null} */
let ACE_STATUS = null;
/** device -> was it up on the PREVIOUS status. Read by healPlayers. @type {Map<string, boolean>} */
let ACE_UP = new Map();

/** Which of the tray's finished candidates cannot be fetched, and off which cards.
 *
 * ⚠️ A DEVICE THE STATUS DOES NOT MENTION COUNTS AS DOWN. The candidate names a card nothing
 * is serving, so its bytes are unreachable either way - and "we have not heard of that one" is not
 * a reason to promise the song will play.
 * @param {Map<string, boolean>} up
 * @returns {{devices: string[], count: number, total: number}}
 */
function deadCandidates(up) {
  const done = (JOBS || []).filter(j => j.status === 'done');
  const bad = done.filter(j => up.get(j.device || '') !== true);
  return {
    devices: [...new Set(bad.map(j => j.device || '').filter(Boolean))],
    count: bad.length,
    total: done.length,
  };
}

/** English for a list of card names: `cuda:0`, `cuda:0 and cuda:1`, `a, b and c`.
 * @param {string[]} xs */
const andList = xs => (xs.length < 3 ? xs.map(esc).join(' and ') : xs.slice(0, -1).map(esc).join(', ') + ' and ' + esc(xs[xs.length - 1]));

/** A starting backend is reachable but not ready. Keep this distinct from an unavailable backend in status rendering.
 * * @param {string[]} devices — the cards whose candidates cannot be fetched
 * @param {AceStatus|null} st
 * @returns {{starting: string[], down: string[]}}
 */
function splitStarting(devices, st) {
  const unit = new Map(((st && st.backends) || []).map(b => [b.device, b.unit]));
  return {
    starting: devices.filter(d => unit.get(d) === 'active'),
    down: devices.filter(d => unit.get(d) !== 'active'),
  };
}

/** Paint or hide the banner. Cheap and idempotent - called from the status poll and the list poll. */
function paintDead() {
  const box = $('aceTrayDead');
  if (!box) return;
  const st = ACE_STATUS;
  // Nothing said yet, or ACE-Step is not installed on this box at all. In the second case there is
  // no button to press and no card to name, so a banner would be noise rather than news.
  if (!st || st.available === false || !st.backends) {
    box.style.display = 'none';
    return;
  }
  const { devices, count, total } = deadCandidates(ACE_UP);
  if (!count || !devices.length) {
    box.style.display = 'none';
    return;
  }
  const { starting, down } = splitStarting(devices, st);
  box.style.display = '';
  // The headline names the two states separately rather than summing them: one card starting and
  // one genuinely stopped is a real position, and the actions differ — one needs waiting, the
  // other needs pressing.
  const head = [
    starting.length
      ? `<b>The ACE-Step backend${starting.length > 1 ? 's' : ''} for ${andList(starting)} ` +
        `${starting.length > 1 ? 'are' : 'is'} running but not ready yet</b> — still starting up, ` +
        `or loading a model.`
      : '',
    down.length
      ? `<b>The ACE-Step backend${down.length > 1 ? 's' : ''} for ${andList(down)} ` + `${down.length > 1 ? 'are' : 'is'} not running.</b>`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  // What to DO differs, and telling him to press Start for a backend that is already up is the
  // half of the old message that wasted his time.
  const advice = down.length
    ? `Press “▶ Start ACE-Step” at the top of the page${starting.length ? ' for that one' : ''} and these play again.`
    : `Nothing to press — they play as soon as the model finishes loading, and this notice clears itself.`;
  box.innerHTML =
    `⚠ ${head} ` +
    `${count === total ? 'These' : `${count} of these`} candidate${count === 1 ? '' : 's'} cannot ` +
    `be played or saved meanwhile. <b>Nothing has been lost</b> - a ` +
    `candidate's audio is kept by the ACE-Step backend, not in this page, and it is still there. ${advice}`;
}

/** Keep a player error visible until the player or source is reloaded.
 * * @param {Map<string, boolean>} up
 */
function healPlayers(up) {
  const tray = $('aceTray');
  if (!tray) return;
  for (const el of /** @type {HTMLAudioElement[]} */ ([...tray.querySelectorAll('audio')])) {
    if (!el.error) continue;
    const row = /** @type {HTMLElement|null} */ (el.closest('.acerow'));
    const j = row && (JOBS || []).find(x => x.id === row.dataset.job);
    const dev = (j && j.device) || '';
    // The TRANSITION is what triggers it - down THEN up - so a backend that has been up all along
    // never re-loads a player, and one that stays down is not retried every four seconds.
    if (up.get(dev) === true && ACE_UP.get(dev) !== true) el.load();
  }
}

onAceStatus(s => {
  ACE_STATUS = s;
  const up = new Map((s.backends || []).map(b => [b.device, b.up === true]));
  healPlayers(up); // reads the PREVIOUS map, so it must run before ACE_UP is replaced
  ACE_UP = up;
  paintDead();
});

function visible() {
  const s = document.querySelector('section[data-panel="acestep"]');
  return !!s && /** @type {HTMLElement} */ (s).style.display !== 'none';
}

// ⚠️ AGAINST THE SERVER'S CLOCK, not the browser's. /acestep/jobs now sends `now` for the same
// reason /book/status and /bulk/status always have: subtracting a server timestamp from the
// browser's Date.now() adds clock skew to every reading on screen. NOW_SKEW is that
// difference, measured on each poll and applied here; it is 0 when the route does not send `now`,
// which keeps this working against an older server rather than showing nonsense.
/** @param {number|null|undefined} t */
function elapsed(t) {
  if (!t) return '';
  const s = Math.max(0, Math.round(Date.now() / 1000 + NOW_SKEW - t));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── 🔴 A KEYED RECONCILE, NOT `innerHTML =` ON A TIMER ────────────────────────────────────
// This list repaints every 2 s, and it used to rebuild every row wholesale. That DESTROYS AND
// RECREATES THE <audio> ELEMENT, so playback stopped shortly after it began. The explicit load
// below caused that; play() already loads the resource when needed.
//

/** @param {AceJob} j */
function candidateRow(j) {
  const where = esc(j.device || '');
  const model = esc((j.model || '').replace('acestep-v15-', ''));
  // ⚠️ THE TITLE IS ITS OWN `.acename` IN EVERY VARIANT. The cell is a flex container now (so the
  // rows can stretch and their separators line up), and a flex container never ellipsizes its own
  // text — it needs a block child to clip. A variant that forgets this does not look broken; it
  // just quietly widens the whole title column for every row in the list.
  if (j.status === 'queued') {
    return `<div class="acerow" data-job="${esc(j.id)}">
      <span class="acewhat"><span class="acename">${esc(j.title || 'Untitled')}</span> <span class="muted">· queued #${j.queue_position || '?'}</span></span>
      <span class="muted acemeta">${where} · ${model}</span>
      <span></span>
      <span class="aceacts"><button class="xs" data-act="remove">Remove</button></span></div>`;
  }
  if (j.status === 'running') {
    return `<div class="acerow" data-job="${esc(j.id)}">
      <span class="acewhat"><span class="spin"></span><span class="acename">${esc(j.title || 'Untitled')}</span>
        <span class="muted">· ${elapsed(j.started_at)}</span></span>
      <span class="muted acemeta">${where} · ${model}</span>
      <span></span>
      <span class="aceacts">
        <span class="muted xs" title="Cancel stops waiting but does not interrupt inference. Use Stop or Unload on this card to terminate its owned child; the queue slot stays reserved until a terminal result or confirmed child exit.">Cancel stops waiting</span>
      </span></div>`;
  }
  if (j.status === 'done') {
    return `<div class="acerow" data-job="${esc(j.id)}">
      <span class="acewhat"><span class="acename" title="${esc(j.title || 'Untitled')}">${esc(j.title || 'Untitled')}</span></span>
      <!-- One fmtSeed for the whole app (8.2.6), and it also stops this printing a bare
           "· seed " with nothing after it on a job whose detail has no seed.
           NOTE no backticks in this comment - one would end the template literal. -->
      <span class="muted acemeta">${where} · ${model}${esc(fmtSeed(j.seed))}</span>
      <!-- ⚠️ THE PLAYER IS WRAPPED, AND THE WRAPPER IS THE GRID CELL. See .acepcell in the CSS:
           an <audio> used directly as a cell is only as tall as itself, so the row's stripe and
           separator paint across 34px of a 42px row and break exactly at the player. -->
      <span class="acepcell"><audio class="aceplayer" controls preload="metadata"
             src="/acestep/jobs/${encodeURIComponent(j.id)}/audio"></audio></span>
      <span class="aceacts">
        <!-- 🔴 8.1-m3 §7 — THE ROW ACTION IS THE PRIMARY WAY INTO A MODE, NOT AN ALTERNATIVE TO
             THE SELECTOR. Every upstream mode opens with "upload source audio" because Gradio has
             nowhere else to get audio from; Vocalis has a tray and a library, so the source is
             almost always something already on screen. These prefill the card and switch it —
             the mode selector stays for the case where you know what you want before you have
             heard anything.
             ⚠️ A candidate does NOT survive its backend restarting, so this can fail. It fails
             with a sentence, at press time, rather than being hidden — the song in front of you
             is the most useful source there is. -->
        <button class="xs" data-act="remix" title="Restyle this song. It becomes the Source on the card above and the mode switches to Remix.">🎛 Remix</button>
        <button class="xs" data-act="repaint" title="Regenerate one time range of this song and leave the rest untouched. Switches the card above to Repaint with this as the Source.">🩹 Repaint</button>
        <button class="xs" data-act="extract" title="Pull one track out of this song — the vocal, the drums, whatever you pick above.">🎚</button>
        <button class="xs" data-act="lego" title="Regenerate ONE track of this song and keep the rest of the arrangement.">🧩</button>
        <button class="xs" data-act="complete" title="Fill in tracks this mix is missing.">➕</button>
        <button class="xs" data-act="retake" title="Another take of this song — its own seed, nudged. No new words needed.">🎲</button>
        <button class="xs" data-act="edit" title="Morph this song toward new words. Its current caption and lyrics are carried in as what it WAS.">✏️</button>
        <button class="xs primary" data-act="save">💾 Save</button>
        <button class="xs" data-act="discard">Discard</button>
      </span></div>`;
  }
  return `<div class="acerow" data-job="${esc(j.id)}">
    <span class="acewhat"><span class="acename">${esc(j.title || 'Untitled')}</span> <span class="err">· ${esc(j.status)}</span></span>
    <span class="muted acemeta">${esc(j.error || '')}</span>
    <span></span>
    <span class="aceacts"><button class="xs" data-act="discard">Dismiss</button></span></div>`;
}

// ── the words a saved song was made from, shown under its row ─────────────────────────────
// Show saved lyrics read-only below playback without a nested scroll area; the box grows to fit.
/** @param {AceLibrarySong} s */
function songWords(s) {
  /** @type {Record<string, unknown>} */
  const t = s.template && typeof s.template === 'object' ? s.template : {};
  const lyrics = String(s.lyrics || t.lyrics || '').trim();
  const caption = String(s.caption || t.caption || '').trim();
  const out = [];
  if (caption) out.push(`<div class="acelyrcap"><b>Style</b> · ${esc(caption)}</div>`);
  out.push(
    lyrics
      ? `<div class="acelyrtext">${esc(lyrics)}</div>`
      : `<div class="small muted">${t.instrumental ? 'Instrumental — no lyrics.' : 'No lyrics were saved with this song.'}</div>`,
  );
  return out.join('');
}

// 🔴 THE ROW IS WRAPPED, AND THE LYRICS LIVE INSIDE THE WRAPPER BUT OUTSIDE THE RENDER'S STATE.
// `reconcile` replaces an element whenever its rendered HTML differs, so if open/closed were part
// of that HTML, expanding a row would rebuild it — destroying the <audio> and stopping the song.
// of. The lyrics are therefore rendered ALWAYS (they never change for a given song, so they add
// nothing to the signature) and shown by toggling the `hidden` PROPERTY afterward. A property is
// invisible to the reconcile, so the player is never touched.
/** @param {AceLibrarySong} s */
function songRow(s) {
  const url = `/acestep/library/${encodeURIComponent(s.id)}/audio`;
  const fmt = DL_FORMAT === 'opus' ? 'opus' : 'flac';
  return `<div class="acesong" data-song="${esc(s.id)}" data-vrow="${esc(s.id)}" draggable="true">
    <div class="acerow" title="Click to see the lyrics and settings this song was made with">
      <!-- 🔴 THE TICK GOES IN THE TITLE CELL, NOT IN A FIFTH GRID TRACK. The row is
           display:contents over a FOUR-track grid (acestep.css), so a fifth child would land in a
           column that does not exist and every song row would stop lining up with the header. The
           cell is already a flex container, so the box simply sits before the star — and flex:0 is
           what stops the one thing this project keeps re-learning, a cell that gives and takes the
           title's width with it.
           ⚠️ draggable=false: the whole row is draggable, and without this, grabbing the checkbox
           starts a drag instead of ticking the box.
           ⚠️ NO checked ATTRIBUTE HERE — the state is applied to the live DOM by applyTicks, and
           putting it in the markup would rebuild the row on the next poll. See TICKED.
           NOTE no backticks in this comment - one would end the template literal. -->
      <span class="acewhat">
        <input type="checkbox" class="acetick" data-acetick="${esc(s.id)}" draggable="false" style="flex:0 0 auto;margin:0"
               title="Tick this song, then press “⇥ Move selected here” on a folder — or “⇤ Remove from folder” at the top of the library to take it back out of one.">
        ${s.favorite ? '<span class="favmark">★</span>' : ''}<span class="acename" title="${esc(s.name)}">${esc(s.name)}</span></span>
      <!-- 🔴 THE SEED IS ON THE ROW, exactly as it is on a candidate. Keeping the value visible
           makes a saved render reproducible.
           put the seed back in Advanced if I want to replicate the song and maybe just change one
           word."* And the second use he named, which is the better argument: *"that would also be
           a nice identifier if I have several favorites with the same title."* A library of
           takes called "Ashes In The Rain" is otherwise a list of identical rows. -->
      <span class="muted acemeta">${esc((s.model || '').replace('acestep-v15-', ''))}${esc(fmtSeed(s.seed))}</span>
      <span class="acepcell"><audio class="aceplayer" controls preload="metadata" src="${url}"></audio></span>
      <span class="aceacts">
        <!-- ⚠️ NO BACKTICKS IN A COMMENT INSIDE THIS TEMPLATE LITERAL — one ends the string and
             turns the rest of the file into a parse error, which is why the class name below is
             written plain. It is controls.css's button.fav.on, the same on/off convention every
             other favorite control on the page uses, and where the gold comes from. -->
        <button class="xs fav${s.favorite ? ' on' : ''}" data-act="star" title="Favorite">${s.favorite ? '★' : '☆'}</button>
        <button class="xs" data-act="rename" title="Rename">✎</button>
        <!-- 8.1-m3 §7, the library half. Same two actions as a candidate row, and a library song
             is the more durable source of the two: it is Vocalis's own file, so it cannot vanish
             because a backend restarted. -->
        <button class="xs" data-act="remix" title="Restyle this song — it becomes the Source on the card above and the mode switches to Remix.">🎛</button>
        <button class="xs" data-act="repaint" title="Regenerate one time range of this song, leaving the rest untouched.">🩹</button>
        <button class="xs" data-act="extract" title="Pull one track out of this song.">🎚</button>
        <button class="xs" data-act="lego" title="Regenerate ONE track and keep the rest of the arrangement.">🧩</button>
        <button class="xs" data-act="complete" title="Fill in tracks this mix is missing.">➕</button>
        <button class="xs" data-act="retake" title="Another take of this song — its own seed, nudged. No new words needed.">🎲</button>
        <button class="xs" data-act="edit" title="Morph this song toward new words. Its current caption and lyrics are carried in as what it WAS.">✏️</button>
        <!-- 🔴 THE DOWNLOAD IS THE POINT OF THE LIBRARY, so it is labeled and sized like it.
             like the main part of this."* -->
        <a class="btn acedl" href="${url}?format=${fmt}" download="${esc(s.name)}.${fmt}"
           title="Download this song as ${fmt === 'opus' ? 'Opus 192k' : 'FLAC'}">⤓ Download</a>
        <button class="xs danger" data-act="del" title="Delete">✕</button>
      </span>
    </div>
    <div class="acelyr" hidden>${songWords(s)}</div>
  </div>`;
}

//: Open/closed is applied to the LIVE DOM, never through the render — see songRow. Called after
//: every reconcile so a row that genuinely was rebuilt (a rename, a favorite) comes back open.
function applyExpanded() {
  const shelf = $('aceLibrary');
  if (!shelf) return;
  for (const wrap of shelf.querySelectorAll('.acesong')) {
    const on = /** @type {HTMLElement} */ (wrap).dataset.song === EXPANDED;
    wrap.classList.toggle('open', on);
    const lyr = wrap.querySelector('.acelyr');
    if (lyr) /** @type {HTMLElement} */ (lyr).hidden = !on;
  }
}

// 🔴 THE ROW ORDER IS `ui/reconcile.js`'s JOB, AND IT DOES IT SINCE 8.9.13. A local pass lived
// here first, because the folder sweep that found the bug owned this one file: an unchanged row
// was never MOVED, so after `⇤ Remove from folder` the song went on painting between the folder
// header and the divider — server unfiled, folder counting (0), screen still showing it filed, and
// permanently, since nothing would ever change that row's HTML again. The fix is four lines beside
// reconcile's own `prev` bookkeeping and now every reconciled list gets it (this one and the stems
// library). See the 🔴 in `reconcile()` for why moving a node cannot pause a playing <audio>.

//: The ticks are applied to the LIVE DOM after every reconcile, exactly like the open/closed state
//: above and for exactly the same reason: a PROPERTY is invisible to the reconcile, so a tick never
//: rebuilds a row and can never cost a playing song its player. `TICKED` is the truth; this is the
//: paint. ⚠️ It has to run after EVERY reconcile, not only after a change: a row rebuilt for an
//: unrelated reason (a rename, a ★) comes back with the markup's default, i.e. unticked.
function applyTicks() {
  const shelf = $('aceLibrary');
  if (!shelf) return;
  for (const box of /** @type {HTMLInputElement[]} */ ([...shelf.querySelectorAll('input.acetick')])) {
    const on = TICKED.has(box.dataset.acetick || '');
    box.checked = on;
    // ⚠️ BOTH the property and the attribute, for the reason the download-format radios above
    // carry both: `.checked` is the live state the user sees, and it does not serialize — so a
    // DOM-dump check reads a fully ticked list as an empty one and cannot tell that from the bug.
    box.toggleAttribute('checked', on);
  }
}

// 🔴 THE ROW YOU CLICKED STAYS UNDER YOUR CURSOR. Reconciliation preserves the scroll position
// as rows expand or collapse.
//
// The cause is that this is an accordion: opening row 5 while row 2 is open COLLAPSES row 2, and
// row 2's lyrics were ABOVE row 5 — so everything below them, including the row just clicked,
// slides up by however tall those lyrics were. Expanding alone never moves the clicked row (the
// box opens beneath it); it is the simultaneous close higher up the list that throws the page.
//
// So: note where the row is, apply the change, and put the scroll back by the difference. The
// list reflows exactly as before; what changes is that the thing being read does not move.
// ⚠️ MEASURED AND CORRECTED IN THE SAME FRAME, with no smooth behavior. A scroll animation here
// would be a second, slower version of the movement being removed.
/**
 * @param {string|null|undefined} songId
 * @param {() => void} apply
 */
function keepRowStill(songId, apply) {
  // 🔴 THE CAST NARROWS AWAY `songId`'s OWN TYPE, NOT JUST `undefined`. `songId && arr.find(...)`
  // types as `string | Element | undefined` to the checker (the left operand's own type survives
  // a truthy `&&`) even though at runtime a truthy `songId` always falls through to `find()`'s
  // result — the string branch is exactly the falsy `''`/`null`/`undefined` case `el && …` below
  // already treats as "nothing to keep still".
  const el = /** @type {Element|undefined} */ (
    songId &&
      [...(($('aceLibrary') || {}).children || [])].find(
        c => /** @type {HTMLElement} */ (c).dataset && /** @type {HTMLElement} */ (c).dataset.song === songId,
      )
  );
  const row = el && el.querySelector('.acerow');
  const before = row ? row.getBoundingClientRect().top : null;
  apply();
  if (before === null) return;
  // `before` is only non-null when `row` was, so the row is present here — a correlation the
  // checker cannot follow across the `apply()` call between them.
  const dy = /** @type {Element} */ (row).getBoundingClientRect().top - before;
  if (dy) window.scrollBy(0, dy);
}

/** @param {string|null} id */
function setExpanded(id) {
  // The row the USER acted on — the one opening, or the one being closed.
  keepRowStill(id || EXPANDED, () => {
    EXPANDED = id || null;
    UIS.setItem(EXPANDED_KEY, EXPANDED || '');
    applyExpanded();
  });
  if (!EXPANDED) return;
  // Selecting a song puts it back in the form above (§4.5.3). The whole row is handed over —
  // ace/form.js decides whether its template still matches, because only that module knows what
  // the templates currently hold.
  const s = SONGS.find(x => x.id === EXPANDED);
  if (s) document.dispatchEvent(new CustomEvent('ace:loadsong', { detail: { song: s } }));
}

// `refreshAce`, not `refresh`: a bare `refresh` already exists elsewhere in the page's
// namespace (voice/training.js), and test_webui_modules reads a generic name defined in a
// module as one that every other user of it ought to be importing. A specific name is the
// fix, not an exemption.
const ACE_SCOPE = 'acelib';

// ── 🔴 THE TICK COLUMN, AND WHY IT IS A MODULE-LEVEL Set (8.9.13) ─────────────────────────
//
// The library supports selecting songs to add to folders and to remove them back to the root.
//
// 🔴 THE SET IS THE TRUTH AND THE DOM IS PAINTED FROM IT, NEVER THE OTHER WAY ROUND. This list is
// reconciled and repainted every 2 s, and a row is rebuilt whenever it genuinely changes — a
// rename, a ★, a folder opening under it — which hands back a fresh `<input>` carrying the
// markup's default. Reading the ticks back off the DOM would therefore lose a selection at an
// interval, silently, while the user was still picking rows: the "it forgets what I ticked"
// complaint, on a timer. `applyTicks` writes the Set onto the live boxes after every reconcile,
// exactly as `applyExpanded` does for the open lyrics box.
//
// 🔴 AND `checked` IS DELIBERATELY NOT PART OF THE ROW'S RENDERED HTML. `reconcile` replaces an
// element the moment its rendered HTML differs from last time, so a tick that appeared in the
// markup would REBUILD the row on the very next poll — the same trap that put the lyrics box
// outside the render's state (see `songRow`). Ticking a song must not cost the song its player.
//
// ⚠️ PRUNED TO WHAT IS ON SCREEN ON EVERY RENDER (see `refreshAce`). A tick left pointing at a row
// nobody can see — a song the template filter has hidden, or one in a folder that has since been
// closed — would silently widen the next ⇥ Move, and nothing on screen would explain where the
// extra songs came from. Same rule the Voices list states at its own `vSel`.
//
// 📌 THE REF IS THE SONG's `id`: the string `data-vrow` and `data-song` already carry, and the one
// the server stamps `folder` against (`folders.for_rows(…, "acelib", …, ref_key="id")`). A second
// identity would agree with the first only by coincidence, and only until a rename.
/** @type {Set<string>} */
const TICKED = new Set();
const aceSelected = () => [...TICKED];

async function refreshAce() {
  if (!visible()) return;
  // 🔴 NEVER REPAINT UNDER A LIVE DRAG. This list rebuilds every 2 s, and a reconcile that
  // replaces the element beneath the cursor kills the drag outright — no drop event, no error,
  // nothing on screen to explain it. It reads as a flaky browser rather than as a bug, which is
  // precisely why `folderDragging()` exists rather than each renderer inventing its own guard.
  // Skipping a tick costs at most 2 s of staleness on a list nobody is looking away from.
  if (folderDragging()) return;
  try {
    // 🔴 THE ONLY CAST IN THIS FUNCTION. `jget` returns `Promise<any>` (util/http.js's own
    // documented boundary) so nothing downstream is contextually typed without it — casting once,
    // here, is what makes every `.filter`/`.map` below a real check on AceJob/AceLibrarySong
    // instead of `any` silently accepting a typo.
    const [jobs, lib] = /** @type {[AceJobsResponse, AceLibraryResponse]} */ (
      await Promise.all([
        jget('/acestep/jobs'),
        jget('/acestep/library' + (TEMPLATE ? '?template_id=' + encodeURIComponent(TEMPLATE) : '')),
      ])
    );
    if (typeof jobs.now === 'number') NOW_SKEW = jobs.now - Date.now() / 1000;
    // Generate-forever runs on the server, and this is the poll that already asks it. ace/form.js
    // owns the button and listens for this — one timer, one route, one authority.
    document.dispatchEvent(new CustomEvent('ace:forever', { detail: { on: !!(jobs.forever || {}).on } }));
    const tray = $('aceTray');
    if (tray) {
      const rows = (jobs.jobs || []).filter(j => !DISCARDED.has(j.id));
      JOBS = rows;
      reconcile(tray, rows, 'job', candidateRow, '<div class="small muted">No candidates yet — press Generate.</div>');
      // Only offered when there is actually something to throw away, and counted off the same
      // payload the rows are painted from so the button and the list cannot disagree.
      const finished = rows.filter(j => j.status === 'done' || j.status === 'failed').length;
      // The banner counts rows, so a new candidate - or a discarded one - changes what it
      // says; it cannot wait up to 4 s for the next status tick to notice.
      paintDead();
      // 🔴 AND THE HEADER'S STOP BUTTON HAS TO KNOW WHAT A STOP WOULD COST. Its confirm
      // used to talk only about VRAM and the song mid-render, and skipped the ceremony entirely
      // when no model was loaded — "a stop with nothing in memory costs nothing" — which is
      // false: it strands every finished candidate in this tray, because their audio lives on
      // the backend being stopped. Same one-timer-one-authority shape as `ace:forever`: the
      // list that KNOWS the count says it, and the button listens.
      document.dispatchEvent(new CustomEvent('ace:candidates', { detail: { finished: rows.filter(j => j.status === 'done').length } }));
      const da = $('aceDiscardAll');
      if (da) {
        da.style.display = finished ? '' : 'none';
        da.textContent = `✕ Discard all (${finished})`;
      }
      // From the SERVER, every poll — the bin is on disk and outlives the page, so a count kept
      // locally would read 0 on a fresh load with a song still recoverable.
      UNDOABLE = jobs.undoable || 0;
      paintUndo();
    }
    // The Clear queue bar exists only while something is actually waiting. Counted off the same
    // payload the rows are painted from, so the button and the list can never disagree.
    const bar = $('aceQueueBar');
    if (bar) {
      const queued = (jobs.jobs || []).filter(j => j.status === 'queued').length;
      const running = (jobs.jobs || []).filter(j => j.status === 'running').length;
      bar.style.display = queued ? 'flex' : 'none';
      const what = $('aceQueueWhat');
      if (what) {
        what.textContent = queued
          ? `${queued} song${queued === 1 ? '' : 's'} waiting` + (running ? ` · ${running} submitted render${running === 1 ? '' : 's'} active; Stop or Unload ends its child` : '')
          : '';
      }
    }
    if ($('aceLibrary')) {
      SONGS = lib.songs || [];
      await loadFolders(ACE_SCOPE);
      aceLibRender();
    }
  } catch (e) {
    /* transient — the next tick tries again */
  }
}

/**
 * Paint the library from `SONGS` — the filter, the order, the folders, the page and the bulk bar.
 *
 * 🔴 SEPARATE FROM `refreshAce` BECAUSE THE THREE NEW CONTROLS MUST NOT REFETCH (9.7.0). A filter
 * box wired to the LOADER puts an HTTP round trip on every keystroke, which is the mistake
 * `ui/filterwiring.js` names in its own header; the order and the pager have nothing to ask the
 * server either, since `/acestep/library` sends the whole list. So the poll fetches and this
 * paints, and every control here calls only this.
 *
 * 📌 `aceLibSearch` below is the exported entry point `ui/filterwiring.js` calls; that file owns
 * the `filtWire` for `#aceLibFilter` along with the other ten boxes. Nothing is imported back from
 * there, so there is no cycle — it is a sink by construction.
 *
 * ⚠️ The helpers it leans on are declared between here and it — `songHay`, `songSortVal`,
 * `libSorted`, `paintLibBar`, `aceLibSearch`, `aceLibGo`.
 */
/**
 * Everything about a saved song worth searching.
 *
 * ⚠️ THE WORDS COME FROM THREE PLACES AND ALL THREE ARE READ, because `songRow`/`songWords` read
 * all three: a row saved before 8.0-m9 has its caption and lyrics on the song, a later one has
 * them on `template`, and since 8.1-m2a `rendered` holds what the 5 Hz model ACTUALLY produced.
 * A filter that knew about only one of them would find a song typed last week and miss the same
 * song typed last month, which is worse than not having a filter.
 * @param {AceLibrarySong} s
 * @returns {string}
 */
function songHay(s) {
  const t = s.template && typeof s.template === 'object' ? s.template : {};
  const r = s.rendered && typeof s.rendered === 'object' ? s.rendered : {};
  return [s.name, s.caption, s.lyrics, t.caption, t.lyrics, r.caption, r.lyrics].filter(Boolean).join(' ');
}

/**
 * One song's value in the current order. `null` is "nothing to order on" and sinks — the rule
 * `vsRowSortVal` states next door: a missing value compared as `''` rides to the TOP of an
 * ascending order, which is where a blank is least explicable.
 * @param {AceLibrarySong} s
 * @returns {string|number|null}
 */
function songSortVal(s) {
  if (LIB_SORT === 'name' || LIB_SORT === 'namez') return String(s.name || '').trim() || null;
  return s.created_at || null;
}

/**
 * Apply the order. 📌 `localeCompare` rather than `<`, so "Ashes" and "ashes" sort together and
 * an accented title lands where a reader expects it — the whole point of offering A–Z at all.
 * @param {AceLibrarySong[]} rows
 * @returns {AceLibrarySong[]}
 */
function libSorted(rows) {
  const desc = LIB_SORT === 'new' || LIB_SORT === 'namez';
  return [...rows].sort((x, y) => {
    const vx = songSortVal(x),
      vy = songSortVal(y);
    if ((vx === null) !== (vy === null)) return vx === null ? 1 : -1; // blanks last, both ways
    const c =
      vx === null ? 0 : typeof vx === 'string' || typeof vy === 'string' ? String(vx).localeCompare(String(vy)) : Number(vx) - Number(vy);
    return desc ? -c : c;
  });
}

/**
 * The count, the tri-state `All` box, the 🗑 button and the pager — everything on the bar that
 * describes the list rather than being part of it.
 *
 * ⚠️ IT PAINTS THE TICK-ALL BOX AS A PROPERTY, never as markup, for the same reason `applyTicks`
 * does: this bar is `data-keep` furniture that the reconcile leaves alone, so it is never rebuilt
 * and there is nothing to serialize into.
 *
 * 🔴 IT TAKES NO ARGUMENTS SO THAT A TICK CAN CALL IT. Ticking a box must update the count, the
 * `All` state and the 🗑 label WITHOUT repainting the rows — re-rendering from a change handler
 * pulls the row out from under the pointer and the next click lands on whatever slid into its
 * place, which is the defect `vsRenderPicker` records. Reading the three numbers off module state
 * is what lets the bar repaint alone.
 */
function paintLibBar() {
  const n = LIB_SHOWN.length,
    all = SONGS.length,
    pages = LIB_PAGES;
  const cnt = $('aceLibCount');
  if (cnt) cnt.textContent = filtCount('aceLibFilter', n, all, 'song');
  const box = /** @type {HTMLInputElement|null} */ ($('aceSelAll'));
  if (box) {
    const on = LIB_SHOWN.filter(id => TICKED.has(id)).length;
    box.checked = !!n && on === n;
    // 🔴 INDETERMINATE IS THE HONEST THIRD STATE. With two of forty ticked, an unchecked box says
    // "nothing is selected" and a checked one says "everything is" — both false, and the second
    // one is dangerous next to a delete button. It is a property with no attribute, which is
    // exactly why it has to be set here rather than rendered.
    box.indeterminate = on > 0 && on < n;
  }
  const del = /** @type {HTMLButtonElement|null} */ ($('aceLibDel'));
  if (del) {
    const k = TICKED.size;
    del.disabled = !k;
    del.textContent = k ? `🗑 Delete selected (${k})` : '🗑 Delete selected';
  }
  const pg = $('aceLibPager');
  if (!pg) return;
  if (pages < 2) {
    pg.style.display = 'none';
    pg.innerHTML = '';
    return;
  }
  // 🔴 `'block'`, NOT `''`. Clearing an inline display falls back to the STYLESHEET, and
  // `.acelibpager` carries `display:none` as its resting state — so `''` hid the pager it had
  // just filled in, and the only symptom was a correct pager nobody could see. Every other
  // `style.display = ''` in this file is over an element whose CSS default is visible.
  pg.style.display = 'block';
  pg.innerHTML =
    `<button class="xs" id="aceLibPrev"${LIB_PAGE ? '' : ' disabled'}>‹ Previous</button>` +
    `<span class="muted" style="margin:0 10px">Page ${LIB_PAGE + 1} of ${pages}</span>` +
    `<button class="xs" id="aceLibNext"${LIB_PAGE < pages - 1 ? '' : ' disabled'}>Next ›</button>`;
  /** @type {VEl} */ ($('aceLibPrev')).onclick = () => aceLibGo(LIB_PAGE - 1);
  /** @type {VEl} */ ($('aceLibNext')).onclick = () => aceLibGo(LIB_PAGE + 1);
}

/**
 * A keystroke in `#aceLibFilter`. Exported because `ui/filterwiring.js` is the one place that
 * names every filter box on the page, and the box wired anywhere else is the box that was
 * silently dead for the whole life of its panel (`spFilter`, found only from that file).
 *
 * 🔴 BACK TO PAGE 1 ON EVERY KEYSTROKE, which is why this is not just `aceLibRender`. `folderPage`
 * clamps, so you can never be stranded past the end — but a filter that shortens the list to two
 * pages while you are on page 4 would drop you onto page 2 with no explanation, and the same
 * keystroke widening it again would not put you back. Page 1 is the only answer that is the same
 * every time. `pgSearch` has done exactly this since the Playground library was paged.
 */
export function aceLibSearch() {
  LIB_PAGE = 0;
  aceLibRender();
}

// 📌 BACK TO THE TOP OF THE LIST ON A PAGE CHANGE. The buttons are at the BOTTOM, so without this
// a press on Next leaves you looking at the end of the new page — the fix candidates.js made and
// the Sources pager copied.
/** @param {number} n */
function aceLibGo(n) {
  LIB_PAGE = Math.max(0, n | 0);
  aceLibRender();
  const shelf = $('aceLibrary');
  if (shelf) shelf.scrollIntoView({ block: 'start' });
}

function aceLibRender() {
  const shelf = $('aceLibrary');
  if (!shelf) return;
  const q = filtQ('aceLibFilter');
  // Every word typed, in any order, over the song's name and the words it was made from. `hay`
  // reaches the lyrics deliberately: "the one about the harbor" is how you look for a song whose
  // title you cannot remember, and the lyrics are already on the row (they are what the expander
  // shows), so this costs no fetch.
  const matched = libSorted(filtRows('aceLibFilter', SONGS, songHay));
  // ⚠️ `query` IS PASSED THROUGH, and it changes what `folderRows` draws: a filter searches the
  // WHOLE scope and renders the hits FLAT, out of their folders, with the folder rows kept as
  // drop targets only. That is folders.js's documented rule for every panel — a scoped search
  // that answers "nothing matches" while the row sits in a closed folder cannot be told from the
  // row not existing.
  const rows = folderRows(ACE_SCOPE, matched, { query: q });
  // 🔴 THE TICKS ARE PRUNED TO WHAT THE FILTER AND THE FOLDERS LEAVE — BUT NOT TO THE PAGE.
  // Paging is NAVIGATION, exactly as opening a folder is, and the Playground library settled this
  // for the same reason: `Select all` reaches every page, so pruning to the visible 25 would make
  // deleting 60 songs impossible in the one gesture that exists to do it. A song the FILTER hides
  // still drops its tick, because that is the honest reading of a button saying "selected".
  const shownIds = rows.filter(e => e.t === 'item').map(e => e.row.id);
  const shown = new Set(shownIds);
  for (const id of [...TICKED]) if (!shown.has(id)) TICKED.delete(id);
  LIB_SHOWN = shownIds;
  // `folderPage` never pages a folder row: they are the navigation, and a pager that swept them
  // away on page 2 would leave unexplained items with no way back and no drop target. It clamps
  // the page too, so a filter that shortens the list cannot strand you on a page that is gone.
  const paged = folderPage(rows, LIB_PAGE, LIB_PER);
  LIB_PAGE = paged.page;
  LIB_PAGES = paged.pages;
  // 8.9 — the folder rows go THROUGH reconcile rather than around it, each carrying the
  // `data-song` key the host already sorts on. `reconcile` inserts in the order of the array
  // it is given, so handing it the display list is the whole of the open-in-place layout:
  // no change to reconcile, and the library keeps the player-preserving repaint it exists for.
  //
  // ⚠️ NOT `data-keep`. Reconcile treats that as FURNITURE and re-inserts it at the top of
  // the host, ahead of every row — which is exactly what a folder whose children sit beneath
  // it must not be. `keyAttr` is what swaps one for the other.
  const disp = folderReconcileRows(paged.rows, r => r.id);
  // The library has players too, and the same 2 s repaint was cutting those off mid-song.
  reconcile(
    shelf,
    disp,
    'song',
    d =>
      d.e.t === 'folder' ? folderBar(d.e, { selectable: true, keyAttr: 'song' }) : d.e.t === 'gap' ? folderGap('song') : songRow(d.e.row),
    // 🔴 THREE EMPTY STATES, NOT ONE, AND THE FILTER'S IS THE NEW ONE. "Nothing saved yet" over a
    // library of 300 songs that a typo has excluded is a lie about the store, and it is exactly
    // the moment a user decides their songs are gone. `filtNone` is the sentence every other
    // filtered list in the app gives, quoting what was typed.
    q
      ? `<div class="small muted">${filtNone('aceLibFilter')}</div>`
      : `<div class="small muted">${TEMPLATE ? 'No saved songs from this template yet.' : 'Nothing saved yet.'}</div>`,
  );
  applyExpanded();
  applyTicks();
  paintLibBar();
}

//: Discarding is a CLIENT-side hide, not a server delete: the job stays in the registry so a
//: reloaded page can still reattach to a render in flight, and nothing on the ACE-Step box is
//: touched. `prune_jobs` reclaims them eventually, which is what it is already for.
const DISCARDED = new Set();

// ── ↩ UNDO DISCARD (8.9.10) ──────────────────────────────────────────────────────────────
//
// 🔴 `DISCARDED` IS WHY THIS NEEDS A CLIENT HALF AT ALL. The tray filters the poll's rows through
// that Set (see `rows` above and the Discard-all handler below), so restoring a record on the
// SERVER is not enough: the row would come back in the payload and be filtered straight out
// again, and the button would look like it did nothing. Only the ids the server actually
// restored are removed — the same Set also holds rows that were SAVED to the library, and those
// must stay hidden.
//
// 📌 The count comes from the server, never from a local guess: the bin survives a restart, so a
// page loaded fresh has no idea what is in it and a client-side counter would show 0 with a song
// sitting in the recycle bin.
let UNDOABLE = 0;
function paintUndo() {
  const b = $('aceUndoDiscard');
  if (!b) return;
  b.style.display = UNDOABLE ? '' : 'none';
  b.textContent = UNDOABLE === 1 ? '↩ Undo discard' : `↩ Undo discard (${UNDOABLE})`;
}

//: The tick lives on the tray's header, OUTSIDE the polled list, so unlike every other control in
//: this panel it is never rebuilt underneath the user — nothing to re-apply after a reconcile.
//: This runs once, at paint, to reflect what was remembered.
function applyAutoplay() {
  const box = /** @type {HTMLInputElement} */ ($('aceAutoplay'));
  if (box) box.checked = AUTOPLAY;
}

/** The candidate to play after `id` leaves the tray: the next one DOWN, wrapping to the top.
 *
 * 🔴 CHOSEN BEFORE THE ROW IS REMOVED, from the list as the user sees it. Reading the order after
 * the removal cannot answer "what was below it" — the row that was below has moved up into its
 * place, and "the one at that index now" is only accidentally the same answer. It stops being the
 * same answer the moment two rows finish between polls.
 * ⚠️ Only FINISHED rows are candidates. Starting playback on a row that is still rendering would
 * hit `409 no audio yet` and leave a dead player, which reads as autoplay being broken.
 * @param {string|null|undefined} id
 * @returns {string|null|undefined}
 */
function nextAfter(id) {
  const tray = $('aceTray');
  if (!tray) return null;
  const rows = /** @type {HTMLElement[]} */ ([...tray.querySelectorAll('.acerow')]).filter(
    r => r.querySelector('audio') && !DISCARDED.has(r.dataset.job),
  );
  if (rows.length < 2) return null; // only the one being dealt with
  const at = rows.findIndex(r => r.dataset.job === id);
  if (at < 0) return null;
  return rows[(at + 1) % rows.length].dataset.job; // wraps to the top of the list
}

/** 🔴 WARM THE SERVER BEFORE ASKING THE ELEMENT TO PLAY.
 *
 * A candidate's bytes are not on this box: `/acestep/jobs/<id>/audio` pulls the WHOLE FLAC from
 * the ACE-Step machine before it returns anything. With `preload="none"` there is nothing
 * buffered, so `play()` starts the element and it sits there showing a pause button with no sound
 * until that download finishes. Seeking appears to fix it because by then the fetch has landed
 * in the server's cache and the next range request is instant.
 *
 * So: ask for one byte first. That is a normal range request, it makes the server do the fetch and
 * cache it, and `play()` afterward is served from memory. The wait moves from "after the control
 * says it is playing" to "before it claims anything", which is the honest place for it.
 *
 * ⚠️ Bounded and non-fatal. If the warm-up fails or is slow we still call `play()` — the old
 * behavior — rather than refusing to play at all over a prefetch that is only an optimization.
 */
/** Play `id` once the tray has caught up. Silent if it is gone or the browser refuses.
 *
 * ⚠️ THERE IS NO LONGER A WARM-UP FETCH BEFORE THIS, AND THE REASON IS A MEASUREMENT.
 * It used to `await` a one-byte range request first, on the theory that the server was slow to
 * produce the bytes. Measured on the real server with a real 27 MB file: ACE-Step answers in
 * 0.017s, the vault read is 0.02s, the handler is 0.03s cold and 0.00s warm, and the body goes
 * over a real socket at ~585 MB/s. Every one of those is fast, so the warm-up bought about 30 ms
 * and cost a full round trip BEFORE `play()` was even called — i.e. it was making the thing it
 * was written to fix slightly worse.
 * 📌 What that measurement leaves is the client: `preload="none"` meant Chrome held no metadata,
 * so `play()` had to open a connection, fetch, parse the header and decode before a sample —
 * which produced "0:00 / 0:00" with a pause button. The players now
 * preload metadata, which Range support (added since that choice) makes cheap.
 * @param {string|null|undefined} id
 */
async function playCandidate(id) {
  if (!id) return;
  const tray = $('aceTray');
  // ⚠️ Looked up fresh. Callers reach here after an `await refreshAce()`, so a row captured
  // earlier may already have been replaced — and playing a detached element is silent in the most
  // confusing possible way: it really plays, into nothing.
  const row = tray && /** @type {HTMLElement[]} */ ([...tray.querySelectorAll('.acerow')]).find(r => r.dataset.job === id);
  const el = row && row.querySelector('audio');
  if (!el) return;
  try {
    // ⚠️ play() returns a promise that REJECTS if autoplay is blocked or the src 404s;
    // unhandled, that is a console error on a feature the user merely ticked.
    await el.play();
    focusPlayer(el);
  } catch (e) {
    /* a browser that refuses to autoplay is not a bug to report */
  }
}

/** 🔴 FOCUS THE PLAYER ITSELF, SO THE ARROW KEYS SEEK.
 *
 * Focusing the audio element after manual play and autoplay enables keyboard seeking without
 * requiring a separate click on the playhead.
 *
 * Clicking the play button focuses that button inside the control's shadow DOM, and arrows do
 * nothing there. Focusing the `<audio>` ELEMENT gives the whole control the keyboard, which is
 * what makes ← and → seek — the same state clicking the scrubber puts it in, without the click.
 *
 * @param {EventTarget|Element|null|undefined} el
 */
function focusPlayer(el) {
  // 🔴 `HTMLElement`, AND IT KEEPS THE OPTIONS ARGUMENT. This used to be a bespoke one-method
  // shape reached through an `unknown` hop, because `dom-permissive.d.ts` merged a ZERO-ARG
  // `Element.focus?(): void` into the same global `Element` interface `HTMLElement` extends — and
  // that overload is what member lookup resolved to, so even a cast to `HTMLElement` rejected the
  // options this call has always passed. That declaration is gone (8.8-m6), so the real
  // `HTMLOrSVGElement.focus(options?: FocusOptions)` on `HTMLElement` applies and the honest type
  // is simply the element. Every caller passes an `<audio>`, so it is true as well as sufficient.
  const target = /** @type {HTMLElement} */ (el);
  try {
    target.focus({ preventScroll: true });
  } catch (e) {
    target.focus();
  }
}

// Manual play gets the same treatment. ⚠️ CAPTURE, because `play` does not bubble — a listener
// on `document` without it never fires, which looks like the fix simply not working.
document.addEventListener(
  'play',
  ev => {
    const el = /** @type {Element} */ (ev.target);
    if (el && el.tagName === 'AUDIO' && el.closest('#aceTray, #aceLibrary')) focusPlayer(el);
  },
  true,
);

// 🔴 A SONG REACHING ITS END ADVANCES TOO — AND THIS WAS MISSING ENTIRELY.
// Autoplay was wired only to Save and Discard, i.e. to a candidate LEAVING the list, because that
// is how the feature was first described. The checkbox also applies when a candidate finishes,
// even though the row remains in the list.
// ⚠️ CAPTURE again: `ended` does not bubble either.
// 📌 Scoped to the tray, because the tick lives on the tray's header and says it is about
// candidates. The library is a shelf you pick from, not a queue that plays itself.
document.addEventListener(
  'ended',
  ev => {
    const el = /** @type {Element} */ (ev.target);
    if (!AUTOPLAY || !el || el.tagName !== 'AUDIO') return;
    const row = /** @type {HTMLElement|null} */ (el.closest('#aceTray .acerow'));
    if (!row) return;
    const next = nextAfter(row.dataset.job);
    if (next && next !== row.dataset.job) playCandidate(next);
  },
  true,
);

document.addEventListener('click', async ev => {
  const undo = /** @type {Element} */ (ev.target).closest && /** @type {Element} */ (ev.target).closest('#aceUndoDiscard');
  if (undo) {
    const r = /** @type {{restored?: number, ids?: string[], undoable?: number}} */ (
      await jpost('/acestep/candidates/undo', {}).catch(() => ({}))
    );
    // 🔴 OUT OF `DISCARDED`, OR THE POLL HIDES IT AGAIN. The tray filters its rows through that
    // Set, so a record the server has restored is still invisible here until its id comes out —
    // and only the restored ids come out, because the same Set also hides rows that were SAVED.
    for (const id of r.ids || []) DISCARDED.delete(id);
    UNDOABLE = r.undoable || 0;
    paintUndo();
    await refreshAce();
    return;
  }
  // Discard all requires confirmation because one press can remove many completed candidates.
  if (/** @type {Element} */ (ev.target).closest && /** @type {Element} */ (ev.target).closest('#aceDiscardAll')) {
    // ⚠️ THE CAST IS BOUND TO ITS OWN NAME, AND THAT IS NOT A STYLE CHOICE (8.3.2). Written inline
    // as `((/** @type {AceJobsResponse} */ (await jget(…))).jobs || []).filter(…)`, Prettier
    // redistributes the parentheses and the cast comes to sit in front of `(…).jobs || []` — so
    // the annotation ends up claiming the ARRAY is an AceJobsResponse, and `.filter` is then an
    // error on a type that has no such member. Run time is identical either way; the TYPE moved.
    // A named intermediate has nowhere to drift to.
    const resp = /** @type {AceJobsResponse} */ (await jget('/acestep/jobs').catch(() => ({})));
    const all = (resp.jobs || []).filter(j => !DISCARDED.has(j.id));
    const finished = all.filter(j => j.status === 'done' || j.status === 'failed').length;
    if (!finished) return;
    const running = all.filter(j => j.status === 'running').length;
    const queued = all.filter(j => j.status === 'queued').length;
    // The confirmation distinguishes submitted work from queued jobs; discarding finished rows
    // affects neither, and a card lifecycle action is required to end submitted work.
    const rest = [
      running ? `${running} still rendering; Stop or Unload on its card ends its child` : '',
      queued ? `${queued} still queued — use Clear queue for those` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    const ok = await modal(
      `Discard ${finished} candidate${finished === 1 ? '' : 's'}?`,
      'They are gone from the tray for good. Nothing you have already saved to the Library is ' +
        'touched.' +
        (rest ? ` <b>Untouched:</b> ${rest}.` : ''),
      [
        { label: 'Keep them', value: 0 },
        { label: `Discard ${finished}`, class: 'danger', value: 1 },
      ],
    );
    if (!ok) return;
    try {
      const r = await jpost('/acestep/candidates/discard_all', {});
      for (const id of (r && r.ids) || []) DISCARDED.add(id);
      UNDOABLE = (r && r.undoable) || 0;
      paintUndo();
    } catch (e) {
      await modal('Could not discard them', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
    }
    await refreshAce();
    return;
  }
  // Clear queue requires confirmation because it removes the only record of queued songs.
  if (/** @type {Element} */ (ev.target).closest && /** @type {Element} */ (ev.target).closest('#aceClearQ')) {
    // Same cast-relocation hazard as #aceDiscardAll above — bound to a name for the same reason.
    const resp = /** @type {AceJobsResponse} */ (await jget('/acestep/jobs').catch(() => ({})));
    const running = (resp.jobs || []).filter(j => j.status === 'running').length;
    const ok = await modal(
      'Clear the queue?',
      'Everything still waiting is dropped and never rendered.' +
        (running
          ? ` <b>${running} submitted render${running === 1 ? '' : 's'} are still active.</b> ` +
            `Cancel stops waiting but does not interrupt inference. Stop or Unload on a card ` +
            `terminates its owned child; its slot remains reserved until a result or confirmed exit.`
          : ''),
      [
        { label: 'Keep the queue', value: 0 },
        { label: 'Clear it', class: 'danger', value: 1 },
      ],
    );
    if (!ok) return;
    try {
      await jpost('/acestep/queue/clear', {});
    } catch (e) {
      await modal('Could not clear the queue', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
    }
    await refreshAce();
    return;
  }
  // 🔴 A TICK IS NOT A CLICK ON THE ROW, AND IT RETURNS BEFORE ANYTHING ELSE IS REACHED.
  // The checkbox sits inside `.acewhat`, which IS the row's open/close target — so without this,
  // ticking a song would also open its lyrics box, fire `ace:loadsong` into the form above and
  // scroll the page to keep the row still, all from a gesture that meant "include this one in the
  // next move". Same guard `vsRenderPicker` carries for `data-vssrcpick` one tab over, and for the
  // same reason it is a `return` rather than a `stopPropagation`: both handlers are on `document`,
  // so there is no propagation between them to stop.
  // ⚠️ The `input` in the `closest('button, a, input')` test below would cover it today, but that
  // test exists for the download-format RADIOS in the header row; a tick that depends on someone
  // else's guard is one refactor away from opening the row again.
  if (/** @type {HTMLElement} */ (ev.target).dataset && /** @type {HTMLElement} */ (ev.target).dataset.acetick !== undefined) return;
  // ── clicking a library row opens what the song was made from, and loads it above ────────
  // 🔴 SCOPED TO `.acerow`, NOT THE WHOLE `.acesong`. The lyrics box is a sibling inside the same
  // wrapper, and a click there must be free to select text — collapsing the box out from under a
  // drag would interrupt text selection. The row itself toggles the expansion.
  // ⚠️ `:not(.acedlhead)` — the format picker is a row of this grid too, and clicking it must not
  // try to expand a song that does not exist.
  const rowEl = /** @type {HTMLElement|null} */ (
    /** @type {Element} */ (ev.target).closest &&
      /** @type {Element} */ (ev.target).closest('#aceLibrary .acesong:not(.acedlhead) > .acerow')
  );
  if (rowEl && !(/** @type {Element} */ (ev.target).closest('button, a, input'))) {
    // The selector matched `.acesong > .acerow`, so the parent is the `.acesong` that carries it.
    const id = /** @type {string} */ (/** @type {HTMLElement} */ (rowEl.parentElement).dataset.song);
    // ⚠️ PRESSING PLAY SELECTS BUT NEVER COLLAPSES. Keep the lyrics visible while the song plays;
    // otherwise pause or scrub would close the box.
    if (/** @type {Element} */ (ev.target).closest('audio')) {
      if (EXPANDED !== id) setExpanded(id);
    } else setExpanded(EXPANDED === id ? null : id);
    return;
  }
  const btn = /** @type {HTMLElement|null} */ (/** @type {Element} */ (ev.target).closest('button[data-act], a[data-act]'));
  if (!btn) return;
  const jobEl = /** @type {HTMLElement|null} */ (btn.closest('[data-job]')),
    songEl = /** @type {HTMLElement|null} */ (btn.closest('[data-song]'));
  // The three casts below are the SELECTORS speaking: `btn` matched `[data-act]` and the two
  // ancestors matched `[data-job]`/`[data-song]`, so each attribute is present by construction.
  const act = /** @type {string} */ (btn.dataset.act);

  if (jobEl) {
    const id = /** @type {string} */ (jobEl.dataset.job);
    // 🔴 §7: THE CANDIDATE IN FRONT OF YOU IS THE MOST USEFUL SOURCE THERE IS, and it is also the
    // most fragile — it lives on its backend and does not survive a restart. Prefilling is
    // client-side and cannot fail; the staging that CAN fail happens on Generate, where the
    // server answers with a sentence naming the reason.
    if (SOURCE_ACTS.has(act)) {
      // The empty-object fallback is a placeholder for "the job vanished between the click and
      // here" — every field the block below reads off `j` is optional on AceJob, so the cast
      // costs nothing honest: a missing job renders exactly as an AceJob with everything absent.
      const j = (JOBS || []).find(x => x.id === id) || /** @type {AceJob} */ ({});
      prefillFromSource({
        token: `cand:${id}`,
        mode: act,
        label: j.title || 'Untitled',
        // m2a put the words the model ACTUALLY rendered on the row. They beat the template's,
        // because a remix starts from what the song IS rather than from what was asked for.
        words: j.rendered || null,
        // 🎲 The seed the Retake box's tooltip promises. It was on the row and never handed
        // over, so every UI Retake sent a blank — "no retake" upstream, a fresh-seed song.
        seed: j.seed,
      });
      return;
    }
    if (act === 'remove') {
      const r = await jpost(`/acestep/jobs/${encodeURIComponent(id)}/cancel`, {});
      if (r && r.was_running) {
        await modal('The song on that card is still generating', esc(r.message || ''), [{ label: 'OK', class: 'primary', value: 1 }]);
      }
      await refreshAce();
    } else if (act === 'discard') {
      // 🔴 THE SUCCESSOR IS PICKED FIRST, while the row is still in the list. See `nextAfter`.
      const next = AUTOPLAY ? nextAfter(id) : null;
      // The server forgets it too, or persistence would hand it back on the next restart.
      DISCARDED.add(id);
      try {
        await jpost(`/acestep/jobs/${encodeURIComponent(id)}/discard`, {});
        UNDOABLE = 1; // this discard is now the one thing ↩ Undo would put back
        paintUndo();
      } catch (e) {
        /* the row is hidden either way; the sweep below reports real failures */
      }
      await refreshAce();
      await playCandidate(next);
    } else if (act === 'save') {
      // 🔴 CHOSEN BEFORE THE DIALOG OPENS, PLAYED ONLY AFTER THE ROW GOES. Picking it here is
      // also what makes Cancel silent: `name === null` returns before anything
      // plays, so a dialog someone backed out of leaves the tray exactly as it was.
      const next = AUTOPLAY ? nextAfter(id) : null;
      const name = await promptForName({
        title: 'Save this song',
        blurb: 'It goes into your library, where you can rename it later.',
        okLabel: 'Save',
        placeholder: 'Ashes In The Rain',
        initial: (jobEl.querySelector('.acename') || {}).textContent?.trim() || '',
        required: 'Give the song a name.',
      });
      if (name === null) return;
      try {
        await jpost(`/acestep/jobs/${encodeURIComponent(id)}/save`, { name });
        DISCARDED.add(id); // it lives in the library now
        // and stops being a candidate on disk as well, for the same reason as Discard.
        try {
          await jpost(`/acestep/jobs/${encodeURIComponent(id)}/discard`, {});
        } catch (e) {
          /* saved is what mattered */
        }
        await refreshAce();
        await playCandidate(next);
      } catch (e) {
        await modal('Could not save it', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
          { label: 'OK', class: 'primary', value: 1 },
        ]);
      }
    }
    return;
  }

  if (songEl) {
    const id = /** @type {string} */ (songEl.dataset.song);
    // §7's library half. A saved song is the more durable of the two sources: it is Vocalis's own
    // file, so unlike a candidate it cannot vanish because a backend restarted.
    if (SOURCE_ACTS.has(act)) {
      // Same placeholder-cast reasoning as the candidate arm above.
      const s = (SONGS || []).find(x => x.id === id) || /** @type {AceLibrarySong} */ ({});
      prefillFromSource({
        token: `song:${id}`,
        mode: act,
        label: s.name || 'Untitled',
        // ⚠️ `rendered` FIRST, and it is the more honest of the two. Think mode rewrites the
        // caption on an ordinary render, so `s.caption` is what was ASKED FOR while `s.rendered`
        // is what the audio actually is — and a remix starts from the song, not from the request.
        // Falls back for any row saved before 8.1-m2a, which have no `rendered` at all.
        words: s.rendered || { caption: s.caption, lyrics: s.lyrics },
        // Same as the candidate arm: the seed the Retake tooltip promises gets handed over.
        seed: s.seed,
      });
      return;
    }
    // 🔴 EVERY ONE OF THESE REPORTS ITS OWN FAILURE. `save` above always did; these three did
    // not, so a 404, a 502 or a vault error was an unhandled rejection inside this listener and
    // the user saw NOTHING — the row just stayed as it was, which reads as "the click didn't
    // register" rather than "it failed". A delete that silently does nothing is the worst of
    // the three, because the natural response is to press it again.
    /**
     * @param {string} what
     * @param {() => Promise<unknown>} fn
     */
    const guard = async (what, fn) => {
      try {
        await fn();
        await refreshAce();
      } catch (e) {
        await modal(what, esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [{ label: 'OK', class: 'primary', value: 1 }]);
      }
    };
    if (act === 'star') {
      const on = btn.textContent.trim() === '☆';
      await guard('Could not change the favorite', () => jpost(`/acestep/library/${encodeURIComponent(id)}`, { favorite: on }));
    } else if (act === 'rename') {
      const name = await promptForName({
        title: 'Rename',
        blurb: 'What should this song be called?',
        okLabel: 'Rename',
        // `.acename` holds the title alone, so no ★-stripping regex is needed — the star is a
        // sibling now. A regex over the whole cell was one favorite-glyph change from silently
        // pre-filling the rename box with "★ Ashes".
        initial: (songEl.querySelector('.acename') || {}).textContent?.trim() || '',
        required: 'Give the song a name.',
      });
      if (name === null) return;
      await guard('Could not rename it', () => jpost(`/acestep/library/${encodeURIComponent(id)}`, { name }));
    } else if (act === 'del') {
      const ok = await modal('Delete this song?', 'The audio goes with it. This cannot be undone.', [
        { label: 'Cancel', value: 0 },
        { label: 'Delete', class: 'danger', value: 1 },
      ]);
      if (!ok) return;
      await guard('Could not delete it', () => jdel(`/acestep/library/${encodeURIComponent(id)}`));
      // The open row just stopped existing. Left set, the key would re-open whichever song later
      // took that id — it cannot, ids are uuids — but it would also survive in the store forever.
      if (EXPANDED === id) setExpanded(null);
    }
  }
});

// Autoplay, remembered.
document.addEventListener('change', ev => {
  if (!(/** @type {Element} */ (ev.target).matches) || !(/** @type {Element} */ (ev.target).matches('#aceAutoplay'))) return;
  AUTOPLAY = !!(/** @type {HTMLInputElement} */ (ev.target).checked);
  UIS.setItem(AUTOPLAY_KEY, AUTOPLAY ? '1' : '');
  // 🔴 TICKING IT STARTS PLAYING. If nothing is playing, start the first undiscarded candidate;
  // otherwise preserve current playback and apply the setting to the next transition.
  // ⚠️ ONLY IF NOTHING IS ALREADY PLAYING. Ticking it mid-song must not snatch playback back to
  // the top of the list — the tick is about what happens NEXT, and restarting the song someone is
  // listening to is the loudest possible way to get that wrong.
  if (!AUTOPLAY) return;
  const tray = $('aceTray');
  const playing = tray && [...tray.querySelectorAll('audio')].some(a => !a.paused && !a.ended);
  if (playing) return;
  const first =
    tray &&
    /** @type {HTMLElement[]} */ ([...tray.querySelectorAll('.acerow')]).find(
      r => r.querySelector('audio') && !DISCARDED.has(r.dataset.job),
    );
  if (first) playCandidate(first.dataset.job);
});

// The tick column. Delegated on `document` like every other listener in this file, because
// #aceLibrary repaints every 2 s and replaces any row that genuinely changed — a listener bound to
// a row would go with the row.
// ⚠️ IT DOES NOT REPAINT. The box already shows the tick, so a render here would buy nothing and
// cost the thing `vsRenderPicker` documents: re-rendering from a change handler pulls the row out
// from under the pointer, and the next click lands on whatever slid into its place.
document.addEventListener('change', ev => {
  const box = /** @type {HTMLInputElement} */ (ev.target);
  const ref = box && box.dataset ? box.dataset.acetick : undefined;
  if (ref === undefined) return;
  if (box.checked) TICKED.add(ref);
  else TICKED.delete(ref);
  // 9.7.0 — the bar, and ONLY the bar. The count, the `All` tri-state and the 🗑 label all
  // describe the selection, so they have to move with it; the rows must not, for the reason above.
  paintLibBar();
});

// ── the library's own controls: order, tick-all, bulk delete (9.7.0) ──────────────────────
// Delegated on `document` like everything else in this file. The bar is `data-keep` furniture and
// is never rebuilt, so a direct binding would work — but a listener that is bound at paint time is
// a listener that stops existing the day someone makes the bar a row, and this file has already
// paid for that twice.
document.addEventListener('change', ev => {
  const t = /** @type {Element} */ (ev.target);
  if (!t.matches || !t.matches('#aceLibSort')) return;
  const v = /** @type {HTMLSelectElement} */ (t).value;
  LIB_SORT = LIB_SORTS.includes(v) ? v : 'new';
  UIS.setItem(LIB_SORT_KEY, LIB_SORT);
  // 🔴 BACK TO PAGE 1. Re-ordering a list moves every row, so staying on page 4 means the songs
  // you were looking at are now somewhere else entirely and page 4 holds strangers. The filter
  // does the same thing for the same reason (see filterwiring.js).
  LIB_PAGE = 0;
  aceLibRender();
});

document.addEventListener('change', ev => {
  const t = /** @type {Element} */ (ev.target);
  if (!t.matches || !t.matches('#aceSelAll')) return;
  // 🔴 EVERY PAGE, NOT THE VISIBLE ONE — `LIB_SHOWN` is the full filtered list. A bulk selection
  // limited to the visible page would require the same repeated gesture as individual deletion.
  if (/** @type {HTMLInputElement} */ (t).checked) for (const id of LIB_SHOWN) TICKED.add(id);
  else TICKED.clear();
  applyTicks();
  paintLibBar();
});

// ── 🗑 DELETE SELECTED ────────────────────────────────────────────────────────────────────
//
// 🔴 ONE REQUEST, AND THE ROUTE IS NEW FOR THAT REASON. Looping the per-id DELETE would be twenty
// read-modify-write cycles over one index file under one lock (see `acelib.delete`), each a window
// for a concurrent save to be lost, and twenty chances to fail halfway with no answer about which
// half. `DELETE /acestep/library` takes the whole list and reports `deleted` and `missing`.
//
// ⚠️ THE CONFIRM NAMES THE COUNT AND THE ROWS ARE NAMED WHEN THERE ARE FEW ENOUGH. A modal that
// says "delete 14 songs?" over a selection spanning pages you cannot see is asking you to trust
// an arithmetic you have no way to check; under seven, the titles fit and they are shown.
document.addEventListener('click', async ev => {
  const b = /** @type {Element} */ (ev.target).closest && /** @type {Element} */ (ev.target).closest('#aceLibDel');
  if (!b) return;
  const ids = aceSelected();
  if (!ids.length) return; // the button is disabled in this state; belt and braces
  const names = ids.map(id => (SONGS.find(s => s.id === id) || {}).name || 'Untitled');
  const ok = await modal(
    ids.length === 1 ? 'Delete this song?' : `Delete ${ids.length} songs?`,
    (names.length <= 6 ? `<b>${names.map(esc).join('</b>, <b>')}</b>.<br><br>` : '') +
      `The audio goes with ${ids.length === 1 ? 'it' : 'them'}. This cannot be undone.`,
    [
      { label: 'Cancel', value: 0 },
      { label: ids.length === 1 ? 'Delete' : `Delete ${ids.length}`, class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  try {
    const r = /** @type {{deleted?: number, missing?: string[]}} */ (await jdel('/acestep/library', { ids }));
    // 🔴 A ROW THAT WAS ALREADY GONE IS SAID OUT LOUD, NOT ROUNDED AWAY. Another tab, or the
    // per-row ✕, can have taken one a second ago; reporting "14 deleted" when 12 went is the
    // quiet arithmetic that gets read as a failed delete — the same lesson the Sources bulk bar
    // records about rows it does not own.
    const gone = (r.missing || []).length;
    if (gone) {
      await modal(
        'Some were already gone',
        `${r.deleted || 0} deleted. ${gone === 1 ? 'One song had' : `${gone} songs had`} already been removed — ` +
          `another tab, or the ✕ on the row, got there first. Nothing else was touched.`,
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
    }
  } catch (e) {
    await modal('Could not delete them', esc(/** @type {ErrLike} */ (e).message || 'the request failed'), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  }
  // The selection is spent either way: the rows it named are gone, or they were never there.
  TICKED.clear();
  // ⚠️ If the open row was one of them, drop the key — otherwise it survives in the server-side
  // store for ever, pointing at a song that cannot come back (the id is a uuid4, assigned once).
  if (EXPANDED && ids.includes(EXPANDED)) setExpanded(null);
  await refreshAce();
});

// Remember the selected download format.
document.addEventListener('change', ev => {
  if (!(/** @type {Element} */ (ev.target).matches) || !(/** @type {Element} */ (ev.target).matches('input[name="aceDl"]'))) return;
  DL_FORMAT = /** @type {HTMLInputElement} */ (ev.target).value === 'opus' ? 'opus' : 'flac';
  UIS.setItem('vocalis-ace-dl', DL_FORMAT); // debounced, and flushed when the tab hides
  refreshAce(); // the <a download> hrefs carry the format
});

// The library filters to the selected template by default (§4.5.3).
document.addEventListener('ace:template', ev => {
  TEMPLATE = (ev.detail && ev.detail.id) || null;
  refreshAce();
});

export function startAceTray() {
  if (TIMER) return;
  // 8.9 — wired HERE, not at module load: `#aceLibrary` does not exist until TRAY_HTML is
  // injected, and `folderWire`/`folderWireDrag` no-op on a missing host, so wiring earlier would
  // silently do nothing. Both are idempotent, and this runs once behind the TIMER guard above.
  // 🔴 `selected` IS WHAT PUTS ⇤ Remove from folder ON THE TOOLBAR, and its absence is the bug.
  // ⇥ Move selected here lives on a folder ROW, and the only route back out
  // was dragging onto a divider that was not even rendered once everything was filed. Answering
  // `selected` gives `folderAddButton` the tick set and it inserts the second button itself.
  // 🔴 AND THE ACTION IS WHY THIS RELOAD TAKES ONE. `⇤` sends 'move' and ✚ Folder sends 'create',
  // and the two must not be treated alike in either direction:
  //   * 'move' MUST REFETCH. The `.folder` stamp came down WITH each row, so a reload that merely
  //     re-rendered would paint the songs straight back into the folder the server has just taken
  //     them out of — right store, wrong screen, and it corrects itself on the next unrelated
  //     refresh, which is how it becomes a bug report about something else. `refreshAce` refetches
  //     both lists, so this is the correct call and not merely an adequate one.
  //   * 'create' MUST NOT CLEAR THE TICKS. "Tick six songs, make a folder for them, press ⇥ Move
  //     selected here" is the flow ✚ Folder exists inside — emptying the selection between the
  //     second and third steps would break it.
  folderAddButton(
    ACE_SCOPE,
    'aceLibTools',
    async act => {
      if (act === 'move') TICKED.clear();
      await refreshAce();
    },
    { selected: aceSelected },
  );
  folderWire('aceLibrary', ACE_SCOPE, {
    // The ticked songs have gone where they were sent, so the selection is spent — the same rule
    // every other list with a tick column follows. 📌 Every action refetches here: this panel has
    // exactly one renderer and it is already on a 2 s poll, so there is no cheaper repaint-from-
    // memory path for `open` to take, unlike the lists `folderWire`'s own note is about.
    reload: async act => {
      if (act === 'move') TICKED.clear();
      await refreshAce();
    },
    selected: aceSelected,
    counts: () => {
      /** @type {Record<string, number>} */
      const n = {};
      for (const x of SONGS) if (x.folder) n[x.folder] = (n[x.folder] || 0) + 1;
      return n;
    },
  });
  // 🔴 BOTH GESTURES NOW, AND THE TICK COLUMN IS WHAT MAKES THE SECOND ONE EXIST. This block used
  // to read "DRAG ONLY, NO ⇥ Move selected here — this library has no tick column yet". With
  // `selected` answered,
  // `folderBar` offers ⇥ Move selected here on every folder row (`selectable: true` in
  // `refreshAce`), `folderAddButton` puts ⇤ Remove from folder beside ✚ Folder, and `dragRefs`
  // takes the WHOLE tick set when the row under the cursor is one of the ticked ones — dragging an
  // unticked row still takes only that row.
  folderWireDrag('aceLibrary', ACE_SCOPE, {
    reload: async act => {
      if (act === 'move') TICKED.clear();
      await refreshAce();
    },
    selected: aceSelected,
  });
  TIMER = setInterval(refreshAce, 2000);
  refreshAce();
}
