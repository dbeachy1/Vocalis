import { reconcile } from '../ui/reconcile.js';
import { $, esc, scrollUnderStick } from '../util/dom.js';
import { UIS } from '../util/uistate.js';
import { cardsFor, state } from '../util/appstate.js';
import { jget, jpost, isHttpError, fetchUnlocked } from '../util/http.js';
import { fmtDate, fmtDur, fmtSeed, fmtSize } from '../util/fmt.js';
import { filtCount, filtNone, filtQ, filtRows } from '../util/filter.js';
import { folderRows, folderPage, folderBar, folderGap, folderTag, folderWire, folderReconcileRows, folderDragging, folderAddButton, folderWireDrag, folderOfRef, loadFolders } from '../ui/folders.js';
import { modal } from '../ui/modal.js';
import { switchTab } from '../ui/tabswitch.js';
import { favBtn, favFirst, favToggle } from '../ui/fav.js';
import { followWhenShown, logInto } from '../ui/log.js';
import { hideAudio } from '../ui/audition.js';
import { trayAudio } from '../ui/trayslot.js';
import { STEM_MODE, stemBadges, stemPills, stemWidgetHTML } from './stemwidget.js';
import { switchStudioPanel } from './studio-tabs.js';
import { spLoadAll } from './speech.js';

const VSS_SCOPE = 'voiceswap_songs';
const SSL_SCOPE = 'stems_library';
const SS_SRC_PAGE = 25;

// Route-row types. 🔴 The legacy app imported these from `media/swapstate.js`, a Voice Swap module
// that is not in this product; the dangling `import('./swapstate.js')` JSDoc references were 31
// tsc errors. `media/stemwidget.js` is the leaf both it and this file already depend on, so it owns
// the typedefs and these are aliases.
/** @typedef {import('./stemwidget.js').SongRow} SongRow */
/** @typedef {import('./stemwidget.js').StemSet} StemSet */
/** @typedef {import('./stemwidget.js').SwapSourceSel} SwapSourceSel */

// ── Stems (4.0 M4): the one split / upload / browse surface ──────────────
// Songs come from the SAME repository as Voice Swap (/voiceswap/songs); jobs ride the
// same rails (/stems/*); and the sets are the SAME sets Voice Swap's stage 1 reads —
// which is what makes "split it here, and every swap of it skips Demucs" true.
// `srcSel` / `srcPage` mirror the legacy Voice Swap `vs` pair (that screen is not in this
// product) and carry the same warning: the
// selection is PRUNED to what the filter shows on every render, never carried blind.
/** Independent state for Stems; song lists are fetched separately from Voice Swap.
 * * @typedef {object} SsState
 * @property {SongRow[]} songs
 * @property {StemSet[]} lib
 * @property {SwapSourceSel|null} song
 * @property {string|null} open      The set whose widget is expanded, by ref.
 * @property {string|null} jobId
 * @property {EventSource|null} es
 * @property {boolean} running
 * @property {string} stage
 * @property {number} stageN
 * @property {{ref: string, name: string}[]} queue  8.5 — songs waiting to be split, in
 *   order. Server-persisted (UIS), so uploading ten and reloading does not lose them.
 * @property {boolean} queueStop   Set by Clear, so a running queue stops after the job
 *   it is on rather than carrying on through a list that no longer exists.
 * @property {number} stageTotal  How many stages THIS job has — 2 for a Demucs split, 4
 *   for a lead extraction. Sent on every 'stage' event; mirrors `vs.stageTotal`.
 * @property {Set<string>} srcSel
 * @property {string|null} srcOpen  8.6.1 — which song row is expanded to show its player.
 *   Clicking a bar previews it; putting it in the queue is an explicit button on the row,
 *   because a row you click to LISTEN to is not a row you meant to commit to work.
 * @property {number} srcPage
 * @property {string} view  8.6.6 — which half of the merged Songs/Your-stems card is
 *   showing: 'songs' or 'lib'.
 */
/** @type {SsState} */
const ss = {
  songs: [],
  lib: [],
  song: null,
  open: null,
  jobId: null,
  es: null,
  running: false,
  stage: '',
  stageN: 0,
  stageTotal: 2,
  queue: [],
  queueStop: false,
  srcSel: new Set(),
  srcOpen: null,
  srcPage: 0,
  view: 'songs',
};
// ── 8.6.6: Songs / Your stems, one card, two pills ───────────────────────────────────────────
//
// Songs and Your stems switch the card between two independently paged lists, avoiding a long
// stacked page.
// after every split — sat below a screenful of songs.
//
// Persist the selected view so returning to the tab restores the same list.
const SS_VIEW_KEY = 'vocalis-ss-view';
/** @param {string} v — 'songs' or 'lib'. */
export function ssSetView(v) {
  ss.view = v === 'lib' ? 'lib' : 'songs';
  const songs = ss.view === 'songs';
  try {
    UIS.setItem(SS_VIEW_KEY, ss.view);
  } catch (e) {}
  document
    .querySelectorAll('[data-ssview]')
    .forEach(b => b.classList.toggle('on', /** @type {HTMLElement} */ (b).dataset.ssview === ss.view));
  // 🔴 display:none and NOT a re-render. The hidden half keeps its DOM — which means the <audio>
  // he left playing in a stem row is still playing when he flips over to look at a song, and
  // still there when he flips back. Rebuilding either half on a pill click would be the same
  // bug 8.6.1 fixed in `ssRenderLib`, arriving from a different direction.
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-ssviewpanel]')).forEach(
    p => (p.style.display = p.dataset.ssviewpanel === ss.view ? '' : 'none'),
  );
  // The toolbars live in the shared header, so they swap with the body rather than with it.
  /** @type {VEl} */ ($('ssSongsTools')).style.display = songs ? 'flex' : 'none';
  /** @type {VEl} */ ($('ssLibTools')).style.display = songs ? 'none' : 'flex';
  /** @type {VEl} */ ($('ssPickerTotals')).style.display = songs ? '' : 'none';
  /** @type {VEl} */ ($('ssLibTotals')).style.display = songs ? 'none' : '';
}
/** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-ssview]')).forEach(
  b => (b.onclick = () => ssSetView(String(b.dataset.ssview))),
);
try {
  ssSetView(UIS.getItem(SS_VIEW_KEY) || 'songs');
} catch (e) {}

/** @type {ReturnType<typeof setInterval>|null} */
let ssTimer = null;
let ssStart = 0;
const ssElapsed = () => {
  const s = Math.floor((Date.now() - ssStart) / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};
/** @type {Record<string,string>} */
const SS_STAGE_LABEL = {
  split: 'splitting stems (Demucs)',
  // 8.4's two extra stages. Named for what is actually happening, because this is the only
  // thing on screen for the several minutes they take — an unlabeled strip on a chain this
  // long reads as a split that has stalled.
  separate: 'finding the backing vocals, and taking the reverb off',
  analyze: 'working out where she sings alone',
  finalize: 'saving stems to the library',
};
// What a split is about to DO, per mode, in the log line that opens the job. This was a
// two-branch ternary that read "vocals / drums / bass / other" for everything that was not
// 2-stem, so `lead` would have been announced by naming three stems it never produces — and
// would have said nothing about the wait, which is the one thing worth saying about it: the
// chain is four models deep and looks, from the strip, like a split that has stalled.
/** @type {Record<string,string>} */
const SS_MODE_DOING = {
  '2stem': 'vocals + instrumental',
  '4stem': 'vocals / drums / bass / other',
  lead: 'cutting out every passage that has backing vocals in it and keeping the clean lead. Slower than it looks — Demucs, then a karaoke model to find the harmonies, then the de-reverb, then the cut',
};
/** @param {string} html
 * @param {string} [cls] */
function ssLogLine(html, cls) {
  logInto(/** @type {VEl} */ ($('ssLog')), html, cls, true);
}
followWhenShown(/** @type {VEl} */ ($('ssLog')));
function ssMode() {
  // 🔴 `lead` IS THE DEFAULT SINCE 8.6.1. The fallback here has to
  // agree with the `checked` radio in index.html, or the two disagree exactly when a radio is
  // missing, which is the case nobody looks at.
  return /** @type {{value?: string}} */ (document.querySelector('input[name=ssMode]:checked') || {}).value || 'lead';
}
// The set already stored for a song, if any — drives the "split" badge in the picker
// and the note under the Split button. Matched on song_ref, which every set we made
// records (and which the migration preserves for the pre-M4 ones).
/** @param {string} ref */
/** The audio URL for a song ref (`uploads/x.mp3`, `acestep/y.flac`). One expression, because
 *  the tray and the picker rows must never disagree about where a song is served from.
 *  @param {string} ref */
function ssSongUrl(ref) {
  const p = String(ref).split('/');
  return `/voiceswap/songs/${encodeURIComponent(p[0])}/${encodeURIComponent(p[1])}/audio`;
}

/** The row's "put this in the split queue" button — or nothing, when the current mode's work
 *  is already done for that song.
 *
 *  The predicate is the SAME one `ssSplitNote` uses to write
 *  its sentence, deliberately: a row that offers the work and a note that says the work is
 *  already done would be the UI disagreeing with itself on the same screen.
 *
 *  ⚠️ `lead` is judged on whether the set holds a LEAD, not on whether it holds stems. A 2-stem
 *  set is exactly the case where a lead extraction is FAST — Demucs does not run again — so
 *  hiding the button there would hide the cheapest useful action in the tab.
 *  @param {SongRow} s
 *  @param {StemSet|null} cur */
function ssQueueBtn(s, cur) {
  const m = ssMode();
  const done = m === 'lead' ? ssHasLead(cur) : !!cur && (cur.mode === '4stem' || (m === '2stem' && cur.mode === '2stem'));
  if (done) return '';
  const queued = ss.queue.some(q => q.ref === s.ref);
  return `<button class="sm" style="margin-left:6px" data-ssqadd="${esc(s.ref)}"${queued ? ' disabled' : ''} title="${
    queued
      ? 'Already in the split queue'
      : `Add this song to the split queue (${SS_MODE_DOING[m] || m}). Nothing starts until you press ▶ Split.`
  }">${queued ? '✓ queued' : '➕ queue'}</button>`;
}

/** @param {string} ref */
/** @param {string} ref */
function ssSetFor(ref) {
  return ss.lib.find(s => s.source !== 'uploaded' && s.song_ref === ref) || null;
}
// 8.4 — does this set already hold a `lead_solo.wav`? The STEM ENTRY decides it, not the row's
// `lead:` block: the block is provenance and can be absent from a set that has the file (an
// older sidecar, a set rebuilt by hand), while the entries are enumerated from what is actually
// on disk. Matched on the stem NAME rather than the filename for the reason the pills are —
// the extension moved under this store once already (7.5.25, WAV → Opus), and `lead_solo` is
// deliberately the one file that stayed WAV.
/** @param {StemSet|null|undefined} c */
function ssHasLead(c) {
  return !!c && (c.stems || []).some(s => s.stem === 'lead_solo');
}
// Which stem the 🎓 sends — and, by answering null, whether it is offered at all. A lead set
// carries the wet `vocals` as well (it is the source of the cut and the escape hatch from a
// bad de-reverb), so a two-item menu was the obvious shape and it is the wrong one: the mode's
// whole promise is "bang, done, that I can send to training", which a button that asks a
// question first does not keep. A set with no lead behaves exactly as it did before 8.4.
// 8.4-m2 — the one threshold §5 calls "the main sensitivity knob", sent with every lead job.
//
// 🔴 THE EXIT THRESHOLD MOVES WITH IT, AND THAT IS NOT A DETAIL. The pair is a Schmitt trigger:
// `enter` turns the backing gate on, `exit` turns it off, and the GAP between them is the whole
// hysteresis — without it the gate chatters on every breath and `min_span_sec` then discards the
// fragments, quietly costing good material. Sending `enter` alone would leave `exit` at its -36
// default, so a user who moved `enter` to -39 would get exit ABOVE enter, which `params_from`
// clamps to equal — no hysteresis at all. The 6 dB gap is the default's gap, kept.
function ssLeadParams() {
  const n = Number(/** @type {HTMLInputElement} */ ($('ssBackingDb')).value);
  if (!Number.isFinite(n)) return {};
  return { backing_enter_db: n, backing_exit_db: n - 6 };
}
/** 8.4-m2 — §7's coverage line: what the detector actually kept, under the pills.
 *
 * 🔴 THIS IS THE QA AFFORDANCE, NOT DECORATION. §4d.2 measured the default gate keeping a median
 * 32% of a song but ANYWHERE from 0% to 81% depending on the track — one song in eight came back
 * with nothing at all. So "was this detection sane?" gets asked often, and the answer has to be
 * visible without opening the file. The spans link is the next click after it.
 * @param {StemSet} c */
function ssLeadNote(c) {
  const L = c.lead;
  if (!L) return '';
  const spans = `${L.spans || 0} span${L.spans === 1 ? '' : 's'}`,
    cover = `${fmtDur(L.kept_sec)} of ${fmtDur(L.source_sec)} kept`,
    dry = L.dereverb ? `de-reverbed (${esc(String(L.dereverb).replace(/\.[^.]+$/, ''))})` : 'reverb left in',
    why = L.dereverb_skipped ? ` <span class="flag">${esc(L.dereverb_skipped)}</span>` : '',
    thin = L.thin ? ' <span class="flag">too little lead vocal found — try another song</span>' : '',
    // §9.8 — and this one OUTRANKS `thin`, because it changes what `thin` MEANS. An empty
    // result normally says the song is stacked end to end and "try another song" is decent
    // advice; when the detection is untrustworthy it may mean nothing about the song at all,
    // and telling him to move on would throw away a vocal that is very likely fine.
    //
    // 🔴 IT ASKS FOR A LISTEN AND CLAIMS NOTHING ELSE. What was measured goes in the TOOLTIP:
    // the row has to be readable at a glance, and the correlation figure is evidence for the
    // warning rather than the warning itself; the user decides whether to proceed.
    dud = L.detector_warning
      ? ` <span class="flag" title="${esc(L.detector_warning)} — which happens both when the model fails to separate a song and when a song is stacked from end to end. No measurement here can tell those apart, so this is a request to listen, not a verdict. The full vocal is on the Vocals pill.">⚠ the lead vocal may be unusable — please check it</span>`
      : '',
    link = `<a href="/stems/library/${encodeURIComponent(c.ref)}/lead_spans?download=1" title="The exact cut points, as JSON — what to read when a result looks wrong">spans</a>`;
  return `<b>Lead vocal</b> · ${spans} · ${cover} · ${dry}${why} · ${link}${dud || thin}`;
}
// 8.4-m2 — "Extract lead vocal" on a set that was split some other way (§9.3). m1 is the mode,
// because that is the one-click ask; this is the affordance for the fifty songs already in the
// library, and it is nearly free once the child exists. Offered only where it can actually run:
// the set needs a vocal to cut, must not already have a lead, and must still know which song it
// came from — /stems/start resolves that ref, and a set you uploaded yourself never had one.
/** @param {StemSet} c */
function ssCanExtract(c) {
  return !ssHasLead(c) && !!c.song_ref && (c.stems || []).some(s => s.stem === 'vocals');
}
// (The legacy `ssTrainStem(c)` — which stem a set trains on — lived here; it belonged to Voice
// Training, which is not in this product, and the snapshot left its JSDoc behind attached to
// `ssStrip`, a tsc error. The JSDoc is gone with the function.)
function ssStrip() {
  const t =
    ss.running && ss.stage
      ? `stage ${ss.stageN}/${ss.stageTotal} — ${SS_STAGE_LABEL[ss.stage] || ss.stage} · elapsed ${ssElapsed()}`
      : ss.running
        ? `starting… · elapsed ${ssElapsed()}`
        : '';
  /** @type {VEl} */ ($('ssStrip')).innerHTML = t ? `${esc(t)} <span class="spin" style="margin:0 0 0 2px"></span>` : '';
}
// 🔴 ALLOWED CARDS ONLY. Same defect as Voice Training's picker (see util/appstate.js's
// `cardsFor`): this read `state.gpus` raw while the swap route enforces ⚙ Settings ▸ Devices, so
// an unticked card was offered here and refused on Start. Less sharp than training's — there is
// no auto-select to pick a forbidden card for you — but a card that cannot work must not be in
// the list, and `auto` must not be able to land on one either.
function ssDeviceOptions() {
  const ssDev = /** @type {HTMLSelectElement} */ ($('ssDevice'));
  const cur = ssDev.value;
  ssDev.innerHTML =
    '<option value="auto">auto (most free VRAM)</option>' +
    cardsFor('stems')
      .map(g => `<option value="cuda:${g.index}">cuda:${g.index} — ${esc(g.name)}</option>`)
      .join('') +
    '<option value="cpu">cpu (very slow)</option>';
  if ([...ssDev.options].some(o => o.value === cur)) ssDev.value = cur;
}
function ssRenderTray() {
  if (ss.song) {
    /** @type {VEl} */ ($('ssTraySong')).innerHTML = `🎵 ${esc(ss.song.name)}`;
    /** @type {VEl} */ ($('ssTraySongMeta')).textContent =
      `${ss.song.source === 'acestep' ? 'ACE-Step' : ss.song.source === 'acelib' ? 'ACE library' : 'uploaded'}${ss.song.size ? ` · ${fmtSize(ss.song.size)}` : ''}${ss.song.mtime ? ` · ${fmtDate(ss.song.mtime)}` : ''}${fmtSeed(ss.song.seed)}`;
    const u =
      '/voiceswap/songs/' + encodeURIComponent(ss.song.ref.split('/')[0]) + '/' + encodeURIComponent(ss.song.ref.split('/')[1]) + '/audio';
    trayAudio(/** @type {VEl} */ ($('ssTrayAudio')), ss.song.ref, u);
  } else {
    /** @type {VEl} */ ($('ssTraySong')).innerHTML = '🎵 <span class="muted">no song picked — choose one below</span>';
    /** @type {VEl} */ ($('ssTraySongMeta')).textContent = '';
    hideAudio(/** @type {VEl} */ ($('ssTrayAudio')));
  }
  /** @type {HTMLButtonElement} */ ($('ssSplit')).disabled = ss.running || !(ss.queue.length || ss.song);
  // 🔴 THE BUTTON SAYS HOW MANY IT IS ABOUT TO DO. A green button
  // that read “▶ Split” whether there was one song behind it or eight made the queued workload unclear, so pressing
  // it with a full queue looked identical to pressing it with a single pick. The count is the
  // whole fix: the control now describes the work rather than the verb.
  /** @type {VEl} */ ($('ssSplit')).textContent = ss.queue.length > 1 ? `▶ Split ${ss.queue.length}` : '▶ Split';
  // The de-reverb tick belongs to `lead` alone — the other two modes hand back a full-length
  // stem there is nothing to de-reverb — so it comes and goes with the mode rather than sitting
  // there grayed out. Toggled the way `vsCleanupWrap` is (:482), i.e. on the WRAPPER: the
  // checkbox keeps its value while hidden, so returning to lead mode preserves the chosen setting.
  /** @type {VEl} */ ($('ssDereverbWrap')).style.display = ssMode() === 'lead' ? '' : 'none';
  // Say what pressing Split will actually DO, before it's pressed — "already split" is
  // the difference between a 90-second wait and none.
  //
  // 🔴 8.4 TURNED THIS INTO A GRID AND EVERY CELL OF IT HAS TO BE TRUE. It was one question with
  // two answers — "does the stored set already satisfy the selected mode?" — and `lead` breaks
  // that three ways: no Demucs mode ever satisfies it and it never satisfies one; the set it
  // leaves behind has `mode: 'vocals'`, which STEM_MODE had no entry for and which therefore
  // rendered as the literal string `undefined`; and "already split" is the wrong question for it
  // anyway, because what decides the wait is whether the set holds a LEAD, not whether it holds
  // stems. A set that holds stems is exactly the case where `lead` is FAST.
  const n = /** @type {VEl} */ ($('ssSplitNote')),
    cur = ss.song ? ssSetFor(ss.song.ref) : null,
    m = ssMode();
  // Prefilled from what this song was ACTUALLY cut at last time, not from the default: the
  // whole point of the knob is that it is per-song (§4d.2), so arriving back at a set you
  // already tuned and being shown -30 again would throw the tuning away on the next press.
  const prev = cur && cur.lead && cur.lead.params && cur.lead.params.backing_enter_db;
  if (Number.isFinite(prev)) /** @type {HTMLInputElement} */ ($('ssBackingDb')).value = String(prev);
  if (!ss.song) n.innerHTML = '';
  else if (m === 'lead' && ssHasLead(cur))
    n.innerHTML = `<span class="muted">This song already has a <b>lead vocal</b>. Splitting again re-runs the detection and the cut over the stored vocal and <b>overwrites that file in place</b> — the set is keyed on the song, so its name does not change and nothing already rendered from it re-renders. This is how you redo one with <b>Remove reverb</b> cleared, if the first came back dull or lifeless.</span>`;
  else if (m === 'lead' && cur)
    n.innerHTML = `<span class="muted">Already split (${STEM_MODE[cur.mode] || cur.mode}), so <b>Demucs does not run again</b> — the lead is cut from the vocal that is already in the set, which is tens of seconds rather than minutes. It <b>adds</b> one file; nothing already there is touched, and no instrumental is made.</span>`;
  else if (m === 'lead')
    n.innerHTML = `<span class="muted">Not split yet, so Demucs runs first to get the vocal and the lead chain follows it — a few minutes. You get <b>one file</b> and no instrumental: the vocal comes back with its choruses cut out of it, so a full-length backing track would no longer line up with it.</span>`;
  else if (!cur) n.innerHTML = '';
  else if (cur.mode === '4stem' || (m === '2stem' && cur.mode === '2stem'))
    n.innerHTML = `<span class="muted">Already split (${STEM_MODE[cur.mode] || cur.mode}) — pressing Split just opens the stored stems below. Delete the set first to redo it.</span>`;
  else if (cur.mode === '2stem')
    n.innerHTML = `<span class="muted">Split as 2-stem already. A 4-stem split re-runs Demucs and <b>adds</b> drums / bass / other to the same set.</span>`;
  else
    n.innerHTML = `<span class="muted">This set has <b>no instrumental</b> — a lead-vocal split never makes one. Splitting it as ${m === '2stem' ? '2-stem' : '4-stem'} runs Demucs and <b>adds</b> the instrumental${m === '4stem' ? ', with drums / bass / other,' : ''} to the same set; everything already in it, the lead included, stays.</span>`;
}
// ── 8.0.2: paging, and a multi-select delete over the Stems tab's song list ──────────────────
// Multi-select deletion applies only to user-owned uploads; ACE library songs remain owned by that
// library. The list uses fixed 25-row paging and a select-all control.
// which will select all. Obviously, only ones that can be deleted."*
//
// 🔴 THIS LIST AND `Voice Swap ▸ Sources` ARE THE SAME FETCH, AND THAT IS THE BUG HE WAS REPORTING.
// `ssLoadSongs` and `vsLoadSongs` both GET `/voiceswap/songs`; the same song therefore carries the
// same `stems stored` badge in both panels, which read as two lists showing "some of the same
// stuff". They ARE one list. Sources adds speech clips, Playground clips and brought-in stem sets
// on top of it and got paging + a bulk delete at 8.0.1 — this panel got neither, so the songs he
// could delete over there were undeletable over here. One store, two views, now two equal deletes.
//
// ⚠️ AND IT IS *NOT* THE STEM-SET LIBRARY FURTHER DOWN THE SAME TAB. That one is `ssRenderLib` over
// `/stems/library`, it lists SEPARATIONS rather than songs, and it has had its own checkboxes since
// 7.5.17. Deleting a song here leaves its stem set standing — the set is keyed on the song's content
// hash, not on the song file existing — which is exactly what the confirm modal says out loud.
//
// 🔴 UPLOADS ONLY, AND THE SERVER IS THE ONE THAT ENFORCES IT. `/voiceswap/songs` DELETE 400s on any
// ref that is not `uploads/<file>` (web/voiceswap.py:253) rather than skipping it silently. The
// missing checkbox on an ACE-Step / ACE library row is the courtesy; the refusal is the guarantee.
/** @type {SongRow[]} */
let ssSrcShown = []; // every row the CURRENT filter shows — all pages, so Select all reaches
// rows he can see the count of but not the checkbox for
let ssSrcTotals = ''; // the totals line without its " · N selected" tail
/** @type {string|null} */
let ssSrcSig = null; // the filter, so a change lands you back on page 1

/** @type {VEl} */ ($('ssSrcBulk')).innerHTML =
  '<label style="display:flex;gap:6px;align-items:center;cursor:pointer" title="Tick every uploaded ' +
  'song the filter is showing — every page of them, not just this one. ACE-Step outputs and ACE ' +
  'library songs are never included: they are deleted where they live.">' +
  '<input type="checkbox" id="ssSrcAll" style="margin:0"><b class="small" id="ssSrcAllNote"></b></label>' +
  '<span class="grow"></span><b id="ssSrcBulkNote" class="small"></b>' +
  '<button class="sm" id="ssSrcBulkNone" title="Clear the selection">Clear</button>' +
  // 8.6.1 — Ticked rows can be added to the split queue; before this, the only action for a
  // selected row was deletion.
  // with them was delete them, which is a selection that can only destroy.
  '<button class="sm" id="ssSrcBulkQueue" title="Put every ticked song into the split queue, in the order shown. Already-queued songs are not added twice.">➕ Add to split queue</button>' +
  '<button class="sm danger" id="ssSrcBulkDel" title="Delete every ticked song from disk">🗑 Delete selected</button>';

/** Repaint the bar and the totals tail WITHOUT touching the rows — the cursor is on one of them,
 *  and re-rendering the list under a click is how a tick lands on the wrong row (8.0.1, :516). */
function ssSrcBulkSync() {
  const bar = $('ssSrcBulk');
  if (!bar) return;
  const del = ssSrcShown.filter(s => s.source === 'uploads'),
    n = ss.srcSel.size;
  // 🔴 8.9.14 — `own` IS WHAT THE DELETE ACTUALLY OWNS, and it is no longer the same as `n`.
  // Now that every row can be ticked (see `ssOneSong`), a selection routinely contains ACE-Step
  // and ACE library songs that this button must not touch — so the count it reports and the state
  // it disables on have to be the deletable subset, not the tick count. Reporting `n` here would
  // promise to delete rows it will silently skip, which is worse than the missing checkbox was.
  const own = ssSrcShown.filter(s => s.source === 'uploads' && ss.srcSel.has(s.ref));
  // The bar is shown whenever there are rows at all — NOT only when something is deletable.
  // It carries `➕ Add to split queue` and `Clear` as well as the delete, and since 8.9.14 the
  // ticks it reads are also what `⇥ Move selected here` and `⇤ Remove from folder` act on. Hiding
  // it on a list with no uploads would hide three working verbs to spare one that is disabled.
  bar.style.display = ssSrcShown.length ? '' : 'none';
  /** @type {VEl} */ ($('ssPickerTotals')).textContent = ssSrcTotals + (n ? ` · ${n} selected` : '');
  const all = /** @type {HTMLInputElement} */ ($('ssSrcAll'));
  if (all) {
    // Select-all now covers every SHOWN row, because the tick is no longer a delete-only control.
    all.checked = n > 0 && n === ssSrcShown.length;
    all.indeterminate = n > 0 && n < ssSrcShown.length;
  }
  const an = $('ssSrcAllNote');
  if (an) an.textContent = `Select all (${ssSrcShown.length} shown)`;
  const note = $('ssSrcBulkNote');
  // ⚠️ THE NOTE SAYS WHAT THE DELETE WILL LEAVE ALONE. A bare "N selected — deleted from disk"
  // over a selection holding ACE-Step rows is a promise the button does not keep.
  if (note)
    note.textContent = !n
      ? ''
      : own.length === n
        ? `${n} selected — deleted from disk`
        : own.length
          ? `${own.length} of ${n} selected can be deleted here — the other ${n - own.length} are kept`
          : `${n} selected — none of them are deletable here`;
  const d = /** @type {HTMLButtonElement} */ ($('ssSrcBulkDel'));
  if (d) d.disabled = !own.length;
  const q = /** @type {HTMLButtonElement} */ ($('ssSrcBulkQueue'));
  if (q) q.disabled = !n;
  const c = /** @type {HTMLButtonElement} */ ($('ssSrcBulkNone'));
  if (c) c.disabled = !n;
}

/** @param {number} pages
 * @param {number} page */
function ssSrcPager(pages, page) {
  const el = $('ssPickerPager');
  if (!el) return;
  if (pages < 2) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = '';
  el.innerHTML =
    `<button class="xs" id="ssSrcPrev"${page ? '' : ' disabled'}>‹ Previous</button>` +
    `<span class="muted" style="margin:0 10px">Page ${page + 1} of ${pages}</span>` +
    `<button class="xs" id="ssSrcNext"${page < pages - 1 ? '' : ' disabled'}>Next ›</button>`;
  /** @type {VEl} */ ($('ssSrcPrev')).onclick = () => ssSrcGo(page - 1);
  /** @type {VEl} */ ($('ssSrcNext')).onclick = () => ssSrcGo(page + 1);
}
// 📌 Back to the top of the list on a page change — the buttons are at the BOTTOM, so without this
// a click on Next leaves you looking at the end of the new page (:541, same fix).
/** @param {number} n */
function ssSrcGo(n) {
  ss.srcPage = Math.max(0, n | 0);
  ssRenderPicker();
  // 9.0.8 — under the pinned header and tab bar, not behind them. See `scrollUnderStick`.
  scrollUnderStick($('ssPicker'));
}

/** @type {VEl} */ ($('ssSrcAll')).onchange = e => {
  // 🔴 8.9.14 — EVERY SHOWN ROW, not only the uploads. This used to narrow to `uploads` so that
  // "ticking the header must never put a ref in the Set that the delete would then have to drop on
  // the floor" — true while the tick existed only to feed the delete. It now also feeds
  // `⇥ Move selected here`, `⇤ Remove from folder` and `➕ Add to split queue`, none of which care
  // where a song came from, so narrowing here would quietly make "select all" mean "select some".
  // The delete is what narrows instead, and `ssSrcBulkSync` says how many it is leaving alone.
  if (/** @type {HTMLInputElement} */ (e.target).checked) ssSrcShown.forEach(s => ss.srcSel.add(s.ref));
  else ss.srcSel.clear();
  ssRenderPicker();
};
/** @type {VEl} */ ($('ssSrcBulkNone')).onclick = () => {
  ss.srcSel.clear();
  ssRenderPicker();
};
/** @type {VEl} */ ($('ssSrcBulkDel')).onclick = () =>
  ssDeleteSongs(ssSrcShown.filter(s => ss.srcSel.has(s.ref) && s.source === 'uploads'));
/** @type {VEl} */ ($('ssSrcBulkQueue')).onclick = () => {
  // In the order SHOWN, not selection order: what he ticked he read down a list, and a queue
  // that ran them in click order would be a different list from the one on screen.
  // ⚠️ Every source, not only uploads — an ACE-Step generation splits exactly like an upload.
  // The tick is a delete-shaped control today only because delete was the first thing built on it.
  const picked = ssSrcShown.filter(s => ss.srcSel.has(s.ref));
  if (!picked.length) return;
  const before = ss.queue.length;
  ssQueuePush(picked.map(s => ({ ref: s.ref, name: s.name })));
  const added = ss.queue.length - before;
  ssLogLine(
    added === picked.length
      ? `Queued ${added} song${added === 1 ? '' : 's'} — press ▶ Split when you are ready.`
      : `Queued ${added} of ${picked.length} — the rest were already in the queue.`,
    'muted',
  );
  ss.srcSel.clear();
  ssRenderPicker();
};

/** The one door to DELETE /voiceswap/songs — the row ✕ and the bulk bar both come through here, so
 *  the wording about kept stems exists once and cannot drift between them.
 * @param {SongRow[]} on */
async function ssDeleteSongs(on) {
  if (!on.length) return;
  const withStems = on.filter(s => ssSetFor(s.ref));
  const list =
    on
      .slice(0, 12)
      .map(s => `<div>· ${esc(s.name)}${ssSetFor(s.ref) ? ' <span class="muted small">stems kept</span>' : ''}</div>`)
      .join('') + (on.length > 12 ? `<div class="muted small">…and ${on.length - 12} more</div>` : '');
  const ok = await modal(
    on.length === 1 ? 'Delete this song?' : 'Delete these songs?',
    `<div><b>${on.length}</b> uploaded song${on.length === 1 ? '' : 's'} — <b>deleted from disk</b>. ${on.length === 1 ? 'It goes' : 'They go'} from this list.</div>
     <div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-top:8px">${list}</div>
     <div class="small muted" style="margin-top:8px">${
       withStems.length
         ? `<b>${withStems.length}</b> of ${on.length === 1 ? 'them' : 'these'} ${withStems.length === 1 ? 'has' : 'have'} stems in <b>Your stems</b> below — <b>the stems are kept</b> and stay listed there, because a set is keyed on the song's content hash rather than on the file. Delete them separately if you want that space back. `
         : ''
     }</div>`,
    [
      { label: 'Cancel', value: 0 },
      { label: '🗑 Delete', class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  // 🔴 ONE REQUEST WITH A LIST, not one per row (:566). The route answers with the refs that
  // ACTUALLY went, so a file still held open by a player reports as not deleted and keeps its row —
  // per-ref truth that N separate requests would throw away.
  let gone = [];
  try {
    const r = await fetchUnlocked('/voiceswap/songs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refs: on.map(s => s.ref) }),
    });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    gone = (await r.json().catch(() => ({}))).deleted || [];
  } catch (e) {}
  if (gone.length < on.length)
    await modal(
      'Some songs were not deleted',
      `${on.length - gone.length} of ${on.length} stayed. A file still open in a player can refuse to delete on Windows — close it and try again.`,
      [{ label: 'OK', class: 'primary', value: 1 }],
    );
  // The SELECTED song going away has to clear the tray too, or Split keeps offering a ref that no
  // longer resolves — and `ssLoadSongs` would re-pick it straight back off UIS.
  if (ss.song && on.some(s => s.ref === /** @type {SwapSourceSel} */ (ss.song).ref)) {
    ss.song = null;
    try {
      UIS.removeItem('vocalis-ss-song');
    } catch (e) {}
  }
  ss.srcSel.clear();
  // ONE store, TWO panels — the whole point of the header comment. Reload both or Sources keeps
  // showing songs this tab just deleted, which is the confusion in the other direction.
  await ssLoadSongs();
}

export function ssRenderPicker() {
  const all = ss.songs || [];
  // A filter change puts you back on page 1: the clamp alone would leave you on page 3 of a list
  // that just became one page long, which reads as "the filter ate my rows" (:601).
  const sig = filtQ('ssPickerFilter');
  if (ssSrcSig !== null && sig !== ssSrcSig) ss.srcPage = 0;
  ssSrcSig = sig;
  const rows = favFirst(filtRows('ssPickerFilter', all, s => s.name));
  // 🔴 THE SELECTION IS PRUNED TO WHAT THE FILTER SHOWS, ON EVERY RENDER. A Set is needed because
  // the list is PAGED — a DOM read would forget page 1 the moment he reached page 2 — so the safety
  // a DOM read gives for free has to be re-established explicitly, and this is it.
  ssSrcShown = rows;
  const visible = new Set(rows.map(s => s.ref));
  [...ss.srcSel].forEach(r => {
    if (!visible.has(r)) ss.srcSel.delete(r);
  });
  // 25 to a page, and the arithmetic lives in ONE place — a second Math.ceil(n/size) is how
  // "Page 7 of 6" ships. The clamp is written BACK, so deleting the last row of the last page
  // lands on the new last page and never on an empty one.
  // 🔴 8.9.14 — FOLDERS ON THIS PICKER, over the SAME `voiceswap_songs` scope Voice Swap ▸ Sources
  // files into. `index.html` tells the user in bold that this "is the same list as Voice Swap ▸
  // Sources, which reads the same store" — and until now one of those two had folders and the
  // other did not, so a song filed over there appeared here unfiled, unlabeled and unmovable.
  // Scope is the DATASET, not the panel; this list was simply not honoring that yet.
  const ssDisp = folderRows(VSS_SCOPE, rows, { query: filtQ('ssPickerFilter') });
  const ssPaged = folderPage(ssDisp, ss.srcPage, SS_SRC_PAGE);
  const pages = ssPaged.pages;
  const page = ssPaged.page;
  ss.srcPage = page;
  const from = page * SS_SRC_PAGE;
  // Counted off the PAGED DISPLAY, never off `rows.length` — `folderPage` pages only the items
  // that are actually painted (the loose rows plus the open folder's children), while `rows` still
  // holds everything filed inside CLOSED folders. Clamping to `rows.length` describes a list
  // nobody is looking at; the same slip was fixed on the Voice Swap picker in this release.
  const shownN = ssPaged.rows.reduce((k, e) => k + (e.t === 'item' ? 1 : 0), 0);
  const to = from + shownN;
  ssSrcTotals = filtCount('ssPickerFilter', rows.length, all.length, 'song') + (pages > 1 ? ` · showing ${from + 1}–${to}` : '');
  ssSrcBulkSync();
  ssSrcPager(pages, page);
  if (all.length && !rows.length) {
    /** @type {VEl} */ ($('ssPicker')).innerHTML = filtNone('ssPickerFilter');
    return;
  }
  /** @type {VEl} */ ($('ssPicker')).innerHTML = rows.length
    ? ssPaged.rows
        .map(e => (e.t === 'folder' ? folderBar(e, { selectable: true }) : e.t === 'gap' ? folderGap() : ssOneSong(e.row, e.in)))
        .join('')
    : '<span class="muted">No songs found — generate one in ACE-Step or upload a file.</span>';
}

/**
 * One row of the Stems ▸ 🎵 Songs picker.
 *
 * 🔴 THE TICK IS ON EVERY ROW, AND IT USED TO BE GATED ON `s.source === 'uploads'` — the exact
 * shape 8.9.13 had to unpick one card over. That column was built for the mass-DELETE, and only an
 * upload can be deleted here, so every ACE-Step generation and ACE library song got a 13px SPACER.
 * The moment folders arrived on this list that gate stopped being about deletion: a row with no
 * checkbox cannot be filed, cannot be un-filed, and cannot be added to the split queue by
 * selection either — three verbs narrowed by a rule that belongs to a fourth.
 *
 * ⚠️ SO THE DELETE IS WHAT NARROWS NOW, not the tick: `ssSrcBulkDel` acts on the removable subset,
 * says how many it is leaving alone, and disables itself when it owns none of them. Same answer,
 * same reasons, as Voice Swap ▸ Sources.
 *
 * @param {any} s
 * @param {string} [inFolder] - the folder's NAME, present only when a filter has flattened the list
 */
function ssOneSong(s, inFolder) {
  const cur = ssSetFor(s.ref);
  const del = s.source === 'uploads';
  return `<div class="item vsrow${ss.song && ss.song.ref === s.ref ? ' active' : ''}" data-song="${esc(s.ref)}" data-vrow="${esc(s.ref)}" draggable="true" style="cursor:pointer">
    <input type="checkbox" data-sssrcpick="${esc(s.ref)}"${ss.srcSel.has(s.ref) ? ' checked' : ''} draggable="false" style="flex:0 0 auto;margin:0" title="${
      del
        ? 'Tick this song, then ⇥ Move selected here on a folder, ➕ Add to split queue, or 🗑 Delete selected.'
        : 'Tick this song, then ⇥ Move selected here on a folder, or ➕ Add to split queue. The mass-delete leaves it alone — an ACE-Step output is deleted in its own tab and an ACE library song in the library.'
    }">
    <div class="grow"><div class="t">${esc(s.name)}${s.source === 'acestep' ? ' <span class="flag">ACE-Step</span>' : ''}${s.source === 'acelib' ? ' <span class="flag">ACE library</span>' : ''}${cur ? ` <span class="badge" title="Its stems are already in the store — from an earlier Split of this song. Extracting its lead vocal skips Demucs. Deleting the song does not delete them.">stems stored</span>` : ''}${folderTag(inFolder || '')}</div>
      <div class="m">${fmtSize(s.size)} · ${fmtDate(s.mtime)}${fmtSeed(s.seed)}</div></div>
    ${ssQueueBtn(s, cur)}
    ${favBtn('favsong2', s.ref, s.favorite)}
    ${del ? `<button class="sm danger" style="margin-left:6px" data-ssdelsong="${esc(s.ref)}" title="Delete this uploaded song from disk. Its stems, if it has any, are kept.">✕</button>` : ''}</div>
    ${ss.srcOpen === s.ref ? `<audio class="w" controls preload="none" style="width:100%;margin:6px 0 2px" src="${ssSongUrl(s.ref)}"></audio>` : ''}`;
}
// A tick updates the Set and repaints the BAR ONLY. Re-rendering the rows from a change handler
// pulls the row out from under the pointer, and the next click lands on whatever slid into its
// place — the mis-delete this panel is otherwise careful about (:664).
/** @type {VEl} */ ($('ssPicker')).addEventListener('change', e => {
  const r = /** @type {HTMLElement} */ (e.target).dataset.sssrcpick;
  if (r === undefined) return;
  if (/** @type {HTMLInputElement} */ (e.target).checked) ss.srcSel.add(r);
  else ss.srcSel.delete(r);
  ssSrcBulkSync();
});
/** @type {VEl} */ ($('ssPicker')).addEventListener('click', async e => {
  // The checkbox sits INSIDE a .vsrow, exactly like the ★ below: without this, ticking a row for
  // deletion would ALSO select it as the song to split. Return before the pick handler is reached.
  if (/** @type {HTMLElement} */ (e.target).dataset.sssrcpick !== undefined) return;
  // 🔴 8.9.14 — AND A FOLDER ROW IS NOT A SONG ROW. `folderBar` renders its own buttons
  // (open / rename / delete / ⇥ Move selected here) and `folderWire` owns them; without this the
  // click would fall through to the song picker below and select whatever row happened to be
  // underneath — the same collision the checkbox guard above exists for, one element wider.
  if (/** @type {HTMLElement} */ (e.target).closest('[data-fact], .vfolder, .vfgap')) return;
  const del = /** @type {HTMLElement} */ (e.target).dataset.ssdelsong;
  if (del) {
    const s = (ss.songs || []).find(x => x.ref === del);
    if (s) await ssDeleteSongs([s]);
    return;
  }
  const fs = /** @type {HTMLElement} */ (e.target).dataset.favsong2; // the SAME star as the Voice Swap picker's
  if (fs) {
    const s = (ss.songs || []).find(x => x.ref === fs);
    favToggle(`/voiceswap/songs/${fs.split('/').map(encodeURIComponent).join('/')}/favorite`, s && s.favorite, async () => {
      await ssLoadSongs();
    });
    return;
  }
  // The explicit queue button. Before the row lookup, because it lives INSIDE a `.vsrow` and
  // would otherwise also toggle the player shut under the click that queued the song.
  const qa = /** @type {HTMLElement} */ (e.target).dataset.ssqadd;
  if (qa) {
    const s = (ss.songs || []).find(x => x.ref === qa);
    if (s) {
      ssQueuePush([{ ref: s.ref, name: s.name }]);
      ssLogLine(`Queued “${esc(s.name)}” — press ▶ Split when you are ready.`, 'muted');
      ssRenderPicker();
    }
    return;
  }
  // 🔴 A CLICK ON THE PLAYER IS NOT A CLICK ON THE ROW. The `<audio>` renders inside `.vsrow`,
  // so without this, pressing play collapses the row that holds the player — the control
  // destroying itself as you use it.
  if (
    /** @type {HTMLElement} */ (e.target).closest('audio') ||
    /** @type {HTMLElement} */ (e.target).closest('button') ||
    /** @type {HTMLElement} */ (e.target).closest('input')
  )
    return;
  const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.vsrow'));
  if (!row || !row.dataset.song) return;
  ss.song = ss.songs.find(s => s.ref === row.dataset.song) || null;
  try {
    UIS.setItem('vocalis-ss-song', row.dataset.song);
  } catch (e2) {}
  // 🔴 8.6.1 — CLICKING A BAR PREVIEWS IT. IT DOES NOT QUEUE IT.
  //
  // 8.6 made the click queue the song, but a row clicked to listen to is not necessarily work to
  // queue; the two
  // were the same gesture. Queueing is now an explicit button on the row (`data-ssqadd`), and
  // the click is free to do the harmless thing. Toggles, so a second click closes the player.
  ss.srcOpen = ss.srcOpen === row.dataset.song ? null : row.dataset.song;
  ssRenderTray();
  ssRenderPicker();
});
async function ssLoadSongs() {
  let ok = true;
  try {
    ss.songs = await jget('/voiceswap/songs');
  } catch (e) {
    ss.songs = [];
    ok = false;
  }
  // 8.9.14 — the folder names for this scope, alongside the rows. Each row's `.folder` is stamped
  // by the server (`folders.for_rows(..., "voiceswap_songs", ...)`), but `folderRows` still needs
  // the scope's folder LIST to draw the headers and to know which ids it can show — and this is
  // the panel's only refetch, so it is where the two have to arrive together.
  await loadFolders(VSS_SCOPE);
  if (!ss.song) {
    let r = null;
    try {
      r = UIS.getItem('vocalis-ss-song');
    } catch (e) {}
    if (r) ss.song = ss.songs.find(s => s.ref === r) || null;
  } else {
    const hit = ss.songs.find(s => s.ref === /** @type {SwapSourceSel} */ (ss.song).ref) || null;
    // ⚠️ KEEP THE PICK THROUGH A FAILED FETCH, CLEAR IT ON A GOOD ONE THAT LACKS IT. The old
    // `…||ss.song` kept it unconditionally, so a song deleted from Sources stayed picked in this
    // tray forever — Split offered a ref that 404s, and UIS re-picked it on every reload.
    if (hit) ss.song = hit;
    else if (ok) {
      ss.song = null;
      try {
        UIS.removeItem('vocalis-ss-song');
      } catch (e) {}
    }
  }
  ssRenderTray();
  ssRenderPicker();
}
export async function ssLoadAll() {
  ssDeviceOptions();
  await ssLoadLib();
  await ssLoadSongs();
}
// Same repository, same contract as the swap tab's upload: content-hashed, no collision.
/** @type {VEl} */ ($('ssSongFile')).addEventListener('change', async () => {
  // 8.5 — Multiple files go straight into the split queue, avoiding separate upload and queue
  // steps for each song.
  // two chores where the whole point was to have none.
  //
  // Uploaded SEQUENTIALLY rather than in parallel: these are 5-50 MB each, the route
  // content-hashes every one, and ten concurrent multipart POSTs into the same store is a
  // thundering herd for no wall-clock — the bottleneck is the disk either way.
  const songInp = /** @type {HTMLInputElement} */ ($('ssSongFile'));
  const files = [.../** @type {FileList} */ (songInp.files)];
  if (!files.length) return;
  /** @type {{ref: string, name: string}[]} */
  const added = [];
  /** @type {string[]} */
  const failed = [];
  try {
    for (const f of files) {
      ssLogLine(`Uploading ${esc(f.name)}…`, 'muted');
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetchUnlocked('/voiceswap/songs', { method: 'POST', body: fd });
      if (r.status === 401) {
        location.href = '/login';
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 🔴 ONE BAD FILE MUST NOT COST THE OTHER NINE. Named at the end, not swallowed.
        failed.push(`${f.name}: ${j.error || r.statusText}`);
        continue;
      }
      added.push({ ref: j.ref, name: j.name });
    }
    if (added.length) {
      ssLogLine(`Uploaded ${added.length} song${added.length === 1 ? '' : 's'} — queued for splitting.`, 'muted');
      await ssLoadSongs();
      ss.song = ss.songs.find(s => s.ref === added[added.length - 1].ref) || ss.song;
      ssQueuePush(added);
      ssRenderTray();
      ssRenderPicker();
    }
    if (failed.length)
      await modal(added.length ? 'Some uploads failed' : 'Upload failed', failed.map(esc).join('<br>'), [
        { label: 'OK', class: 'primary', value: 1 },
      ]);
  } finally {
    songInp.value = '';
  }
});
/** @type {VEl} */ ($('ssPickerRefresh')).onclick = () => {
  ssLoadSongs();
  ssLoadLib();
};
document.querySelectorAll('input[name=ssMode]').forEach(r => r.addEventListener('change', ssRenderTray));
// job flow (the vs pattern verbatim, on /stems/*)
/** @param {boolean} r */
function ssSetRunning(r) {
  ss.running = r;
  /** @type {VEl} */ ($('ssSplit')).style.display = r ? 'none' : 'inline-block';
  /** @type {VEl} */ ($('ssCancel')).style.display = r ? 'inline-block' : 'none';
  if (r) {
    /** @type {HTMLButtonElement} */ ($('ssCancel')).disabled = false;
    /** @type {VEl} */ ($('ssCancel')).innerHTML = '■ Cancel';
    if (!ssTimer) ssTimer = setInterval(ssStrip, 1000);
  } else {
    if (ssTimer) {
      clearInterval(ssTimer);
      ssTimer = null;
    }
    ss.stage = '';
    ss.stageN = 0;
    ss.stageTotal = 2;
    ssStrip();
  }
  ssRenderTray();
}
function ssEndJob() {
  ssSetRunning(false);
  if (ss.es) {
    ss.es.close();
    ss.es = null;
  }
}
/** @param {string} id */
function ssOpenStream(id) {
  const es = new EventSource('/stems/events/' + id);
  ss.es = es;
  es.onmessage = ev => ssHandleEvent(JSON.parse(ev.data));
  es.onerror = async () => {
    if (ss.es !== es) return;
    try {
      const s = await jget('/stems/status/' + id);
      if (['done', 'failed', 'canceled'].includes(s.status)) {
        ssLogLine('Connection closed — job ' + s.status + '.', 'muted');
        ssEndJob();
      }
    } catch (e) {
      ssLogLine('Connection lost — job no longer available.', 'drop');
      ssEndJob();
    }
  };
}
/**
 * One SSE event on `/stems/events/<id>`.
 * @typedef {object} SsJobEvent
 * @property {string} type    'job_start' · 'stage' · 'log' · 'job_done' · 'error' · 'canceled'.
 * @property {string} [stage] An `SS_STAGE_LABEL` key, on 'stage'.
 * @property {number} [n]
 * @property {number} [total] How many stages this job has — 2 for a Demucs split, 4 for
 *   a lead extraction. The strip counted `/2` as a literal until 8.4 gave it a second shape.
 * @property {string} [line]  A log line, on 'log'.
 * @property {string} [ref]   The finished set's ref, on 'job_done'.
 * @property {string} [message] On 'error'.
 */
/** @param {SsJobEvent} ev */
function ssHandleEvent(ev) {
  switch (ev.type) {
    case 'job_start':
      if (!ssStart) ssStart = Date.now();
      break;
    case 'stage':
      ss.stage = /** @type {string} */ (ev.stage);
      ss.stageN = /** @type {number} */ (ev.n);
      // 🔴 8.4 — TAKEN FROM THE EVENT, NOT HARD-CODED. This read `stage ${n}/2` as a
      // literal, which was true for exactly as long as every split had two stages; a lead
      // extraction has four and the strip would have counted "stage 4/2" at it. The swap
      // side has always done it this way (`vs.stageTotal`, :1516) — this half just never
      // had a second shape to notice.
      ss.stageTotal = ev.total || 2;
      ssStrip();
      break;
    case 'log':
      ssLogLine(esc(ev.line), 'muted');
      break;
    case 'job_done':
      ssLogLine(`✅ Done in ${ssElapsed()} — stems saved below.`, 'ok');
      ssEndJob();
      ssShowSplit(/** @type {string} */ (ev.ref));
      break;
    case 'error':
      ssLogLine('❌ ' + esc(ev.message), 'drop');
      ssEndJob();
      break;
    case 'canceled':
      ssLogLine('Canceled — nothing was saved.', 'muted');
      ssEndJob();
      break;
  }
}
// 🔴 8.6 — THE GREEN SPLIT BUTTON IS THE ONLY GO BUTTON, AND IT RUNS THE QUEUE.
//
// The primary Split button runs the queue. A separate per-song start control created two
// competing ways to start work and could ignore queued items.
/** @type {VEl} */ ($('ssSplit')).onclick = async () => {
  // A song picked but somehow not queued (a restored selection from before 8.6) still splits,
  // because "press Split and it does the thing in front of you" must never stop being true.
  if (ss.song && !ss.queue.some(q => q.ref === /** @type {SwapSourceSel} */ (ss.song).ref) && !ss.queue.length)
    ssQueuePush([{ ref: ss.song.ref, name: ss.song.name }]);
  await ssQueueRun();
};
/** @type {VEl} */ ($('ssCancel')).onclick = async () => {
  if (!ss.jobId) return;
  /** @type {HTMLButtonElement} */ ($('ssCancel')).disabled = true;
  /** @type {VEl} */ ($('ssCancel')).innerHTML = '<span class="spin"></span>Canceling…';
  try {
    await jpost('/stems/cancel/' + ss.jobId, {});
  } catch (e) {}
};
// One fetch of the stem store. 🔴 In the legacy app this lived in `media/voiceswap.js` (it also
// fed Voice Swap's picker via `vs.sets`) and `stems.js` called it as a bare global; Voice Swap is
// not part of this product, so that definition was gone and every library load threw a
// ReferenceError (found by tsc, TS2304). It is owned here now.
// 8.9 — the Stems library's own scope. 🔴 NOT `voiceswap_songs`: this lists every separation, ours
// and yours, as a SET. 📌 In `folders.RENAME_MOVES_REF`: `set_ref()` is `safe_name(song) + '_' +
// h[:8]`, and the M4 migration re-forms it, so `stems.migrate()` carries the assignment across.
async function stemSetsLoad() {
  try {
    ss.lib = await jget('/stems/library');
    await loadFolders(SSL_SCOPE); // names + order; the rows arrive already stamped
  } catch (e) {
    ss.lib = [];
  }
}
// the stems library — one widget per SET (per song, not per split mode)
async function ssLoadLib() {
  await stemSetsLoad();
  ssRenderLib();
  ssRenderTray();
  if (ss.songs.length) ssRenderPicker();
}
// Split out of the loader so the filter re-renders from the sets we already have.
export function ssRenderLib() {
  // 🔴 NEVER REPAINT UNDER A LIVE DRAG (8.9). A finished split refreshes this list, and a
  // reconcile that replaces the element under the cursor kills the drag outright — no drop
  // event, no error, nothing on screen to explain it. Same guard, same reason, as the ACE
  // library's 2 s tick; skipping one refresh costs a few seconds of staleness on a list the
  // user is demonstrably looking at.
  if (folderDragging()) return;
  const all = ss.lib || [];
  const shown = filtRows('ssLibFilter', all, c => c.song);
  // The size is of what is SHOWN, so it always describes the rows under it.
  const tot = shown.reduce((s, c) => s + (c.size || 0), 0);
  /** @type {VEl} */ ($('ssLibTotals')).textContent = !all.length
    ? ''
    : `${filtCount('ssLibFilter', shown.length, all.length, 'set')} · ${fmtSize(tot)}`;
  // 🔴 8.6.1 — RECONCILED, NOT REPAINTED. This used to assign `innerHTML`, so any refresh of the
  // library — and finishing a split refreshes it — rebuilt every row, stopping active playback
  // and closing the open row.
  //
  // `reconcile` replaces a row ONLY when its rendered HTML actually differs, and carries a live
  // player across a row that genuinely changed. A finished set's row never changes, so a new set
  // arriving is an insert and nothing else is touched. The stable widget id in `stemwidget.js`
  // is the other half of this — without it every row's HTML differs on every pass.
  // 8.9 — the folder rows go THROUGH reconcile, each carrying the `setkey` the host already
  // orders on, exactly as the ACE library does. ⚠️ NOT `data-keep`: reconcile treats that as
  // FURNITURE and re-inserts it at the top of the host, ahead of every row — which is what a
  // folder whose children sit directly beneath it must not be. `keyAttr` swaps one for the other.
  // 📌 And the whole point of reconcile here survives: a set's row is unchanged by the folder
  // overlay, so the `<audio>` you are listening to is still carried across a refresh.
  const ssDisp = folderReconcileRows(folderRows(SSL_SCOPE, shown, { query: filtQ('ssLibFilter') }), c => c.ref);
  reconcile(
    /** @type {VEl} */ ($('ssLib')),
    ssDisp,
    'setkey',
    d =>
      d.e.t === 'folder'
        ? folderBar(d.e, { selectable: true, keyAttr: 'setkey' })
        : d.e.t === 'gap'
          ? folderGap('setkey')
          : ssOneSet(/** @type {StemSet} */ (d.e.row), d.e.in),
    all.length
      ? filtNone('ssLibFilter')
      : '<span class="muted">No stems yet — split a song from the 🎵 Songs pill, or upload a set below.</span>',
  );
  ssPickSync();
}

/**
 * One stem-set row — the widget lifted out of `ssRenderLib` VERBATIM so folder rows could
 * interleave into the same reconcile list. Nothing about the widget changed.
 * @param {StemSet} c
 * @param {string} [inFolder] - the folder's NAME, present only when a filter has flattened the list
 */
function ssOneSet(c, inFolder) {
  return stemWidgetHTML({
    key: c.ref,
    drag: c.ref,
    tag: folderTag(inFolder || ''),
    title: c.song,
    badges: stemBadges(c),
    pills: stemPills(c),
    open: c.ref === ss.open,
    // 7.5.17 — A set can contain many large WAVs; `/stems/library` DELETE already accepts a list,
    // so the UI exposes that existing bulk operation.
    pick: c.ref,
    size: c.size || 0,
    zip: `/stems/library/${encodeURIComponent(c.ref)}/zip`,
    meta: `${fmtDur(c.duration_s)} · ${(c.stems || []).length} stem${(c.stems || []).length === 1 ? '' : 's'} · ${fmtSize(c.size)} · ${fmtDate(c.created_ts)}`,
    note: ssLeadNote(c),
    acts: `${ssCanExtract(c) ? `<button class="sm" data-sslead="${esc(c.ref)}" title="Extract the isolated lead vocal from this set. Demucs does not run again; the cut uses the vocal already in the set.">✂ Lead</button>` : ''}
      ${(c.stems || []).some(s => s.stem === 'vocals' || s.stem === 'lead_solo') ? `<button class="sm" data-ssspeech="${esc(c.ref)}" title="Add this vocal to the shared Speech library">Add to Speech</button>` : ''}
      <button class="sm danger" data-ssdel="${esc(c.ref)}" title="Delete this stem set">✕</button>`,
  });
}

// ── 8.5: the split queue ─────────────────────────────────────────────────────────────────────
//
// Multi-upload places several songs in one split queue, allowing one start action to process them
// into a training set.
//
// 🔴 SEQUENTIAL, NOT PARALLEL, AND THAT IS NOT LAZINESS. Every split takes SWAP_LOCK for its
// Demucs stage — and, since 8.5, again for the separation when it is on a card. Firing ten jobs
// at once would put nine of them straight into that queue anyway, except that the server would
// also be holding ten job records, ten SSE streams and ten scratch dirs to do it. One at a time
// is what the lock already imposes; this just stops pretending otherwise.
const SS_QUEUE_KEY = 'vocalis-ss-queue';

/** @returns {{ref: string, name: string}[]} */
function ssQueueLoad() {
  try {
    const v = JSON.parse(UIS.getItem(SS_QUEUE_KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => x && x.ref) : [];
  } catch {
    return [];
  }
}
function ssQueueSave() {
  UIS.setItem(SS_QUEUE_KEY, JSON.stringify(ss.queue));
}
/** @param {{ref: string, name: string}[]} items */
function ssQueuePush(items) {
  // Deduped on ref: uploading the same file twice is a no-op server-side (songs are
  // content-hashed), so it must be a no-op here too rather than splitting it twice.
  const have = new Set(ss.queue.map(q => q.ref));
  for (const it of items)
    if (it && it.ref && !have.has(it.ref)) {
      ss.queue.push({ ref: it.ref, name: it.name || it.ref });
      have.add(it.ref);
    }
  ssQueueSave();
  ssQueueRender();
}
function ssQueueRender() {
  const box = $('ssQueue'),
    note = $('ssQueueNote');
  if (!box) return;
  if (note) note.textContent = ss.queue.length ? `${ss.queue.length} song${ss.queue.length === 1 ? '' : 's'} waiting` : 'empty';
  box.innerHTML = ss.queue.length
    ? ss.queue
        .map(
          (q, i) =>
            `<div class="row" style="gap:6px;align-items:center;padding:1px 0"><span class="muted" style="min-width:1.6em">${i + 1}.</span><span class="grow">${esc(q.name)}</span><button class="sm" data-ssqdel="${esc(q.ref)}" title="Take this one out of the queue">✕</button></div>`,
        )
        .join('')
    : '';
  // 8.6 — no `ssQueueGo` to enable any more: Split is the go button. `ssSplit` is enabled from
  // `ssRenderTray`, which reads `ss.queue.length`, so re-render it whenever the queue moves.
  ssRenderTray();
}
/** Wait for one split job to reach a terminal state. Resolves with its status.
 * @param {string} id */
async function ssAwaitJob(id) {
  // Polled rather than resolved off the SSE stream: the stream is what drives the LOG and the
  // strip, and it is already wired. Reaching into its handler to also settle a promise would
  // couple the queue to the live-view plumbing for no gain — a 2 s poll on a job that takes
  // minutes costs nothing and cannot miss a terminal state the way a dropped event can.
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    let st;
    try {
      st = await jget(`/stems/status/${encodeURIComponent(id)}`);
    } catch {
      return 'failed'; // the job record is gone; treat it as over rather than spinning
    }
    if (st.status === 'done' || st.status === 'failed' || st.status === 'canceled') return st.status;
  }
}
async function ssQueueRun() {
  if (!ss.queue.length || ss.running) return;
  ss.queueStop = false;
  const total = ss.queue.length;
  let done = 0;
  // A fresh log per press, as the single-song path always did: the previous run's lines above a
  // new one is how you end up reading a stale error as a live one.
  /** @type {VEl} */ ($('ssLog')).innerHTML = '';
  ssLogLine(
    total === 1
      ? `Splitting “${esc(ss.queue[0].name)}” — ${SS_MODE_DOING[ssMode()] || ssMode()}…`
      : `Splitting ${total} songs — ${SS_MODE_DOING[ssMode()] || ssMode()}…`,
    'muted',
  );
  while (ss.queue.length && !ss.queueStop) {
    const next = ss.queue[0];
    let r;
    try {
      r = await jpost('/stems/start', {
        song: next.ref,
        mode: ssMode(),
        dereverb: /** @type {HTMLInputElement} */ ($('ssDereverb')).checked,
        params: ssLeadParams(),
        device: /** @type {HTMLSelectElement} */ ($('ssDevice')).value,
        // 8.6.2 — HOW MANY ARE STILL BEHIND THIS ONE. Only this side knows: the queue lives in
        // the browser, so the server sees a series of unrelated /stems/start calls. A satellite
        // that keeps its separator loaded between songs needs telling when to let go, and the
        // last song of a queue sends 0, which releases it. Worth ~6.5 s per song after the first.
        queue_remaining: Math.max(0, ss.queue.length - 1),
      });
    } catch (e) {
      // 🔴 THE FAILED ONE STAYS IN THE QUEUE. Dropping it would leave him to work out which of
      // ten songs never got split, from a log that has scrolled — the whole point of walking
      // away is not having to reconstruct that.
      ssLogLine(
        `Queue stopped at “${esc(next.name)}” — ${esc(/** @type {ErrLike} */ (e).message)}. It is still first in the queue.`,
        'err',
      );
      break;
    }
    if (r.cached) {
      // One song, already split: OPEN IT. That is what the single-song button did before 8.6,
      // and it is the answer to "why did nothing happen" when the work was done last week.
      // In a longer queue it is just a skip — opening a set per song would fight the run.
      ssLogLine(
        `“${esc(next.name)}” was already split — ${total === 1 ? 'opening the stored stems (delete the set to redo it)' : 'skipping'}.`,
        'muted',
      );
      if (total === 1) ssShowSplit(r.ref);
    } else {
      ss.jobId = r.job_id;
      ssStart = Date.now();
      ssSetRunning(true);
      ssStrip();
      ssOpenStream(r.job_id);
      const status = await ssAwaitJob(r.job_id);
      ssSetRunning(false);
      if (status !== 'done') {
        ssLogLine(`Queue stopped: “${esc(next.name)}” ${status}. It is still first in the queue.`, 'err');
        break;
      }
    }
    ss.queue.shift();
    ssQueueSave();
    ssQueueRender();
    done++;
    ssLogLine(`Queue: ${done}/${total} done.`, 'muted');
  }
  await ssLoadLib();
  ssQueueRender();
  if (!ss.queue.length) ssLogLine(`Queue finished — ${done} of ${total} split. The sets are below.`, 'muted');
}
  // 🔴 8.6.1 — RESTORE THE QUEUE. `ssQueueLoad` was written in 8.5 but never called, so reloads
  // emptied the queue and the next save overwrote the persisted list with `[]`.
//
// ⚠️ The read is synchronous against the state the server injected into the page, so this can run
// in a module body without awaiting anything (see util/uistate.js).
ss.queue = ssQueueLoad();
ssQueueRender();

if ($('ssQueueClear'))
  /** @type {VEl} */ ($('ssQueueClear')).onclick = () => {
    ss.queue = [];
    ss.queueStop = true;
    ssQueueSave();
    ssQueueRender();
  };
if ($('ssQueue'))
  /** @type {VEl} */ ($('ssQueue')).addEventListener('click', e => {
    const ref = /** @type {HTMLElement} */ (e.target).dataset.ssqdel;
    if (!ref) return;
    ss.queue = ss.queue.filter(q => q.ref !== ref);
    ssQueueSave();
    ssQueueRender();
  });

// ── 7.5.17: multi-select delete ──────────────────────────────────────────────────────────────
// `/stems/library` DELETE has accepted `{refs: [...]}` since 4.0; the server was
// never the limitation, only the row's single `✕`.
//
// 🔴 THE SELECTION IS READ OFF THE DOM, NEVER KEPT IN A PARALLEL SET. The filter box re-renders
// this list on every keystroke, so a remembered selection would drift out of step with what is on
// screen — and "delete selected" against a stale set is the one mistake here that costs gigabytes
// of his audio. Only ticks he can currently SEE can be deleted, which is also the honest reading
// of a button that says "delete selected".
//
// ⚠️ The bar is hidden with nothing ticked rather than shown disabled: it sits directly above the
// list, and a permanently-present delete control over a library is a bigger invitation to a
// mis-click than it is a discoverability win. The checkboxes are the affordance.
function ssPicked() {
  return [...document.querySelectorAll('#ssLib input[data-sspick]:checked')].map(b => ({
    ref: /** @type {string} */ (/** @type {HTMLInputElement} */ (b).dataset.sspick),
    size: +(/** @type {string} */ (/** @type {HTMLInputElement} */ (b).dataset.size)) || 0,
  }));
}
function ssPickSync() {
  const bar = $('ssBulk');
  if (!bar) return;
  const on = ssPicked();
  bar.style.display = on.length ? '' : 'none';
  const n = $('ssBulkNote');
  if (n)
    n.textContent = on.length
      ? `${on.length} set${on.length === 1 ? '' : 's'} selected · ${fmtSize(on.reduce((s, c) => s + c.size, 0))} to reclaim`
      : '';
}
/** @type {VEl} */ ($('ssLib')).addEventListener('change', e => {
  if (/** @type {HTMLElement} */ (e.target).dataset.sspick !== undefined) ssPickSync();
});
if ($('ssBulkAll'))
  /** @type {VEl} */ ($('ssBulkAll')).onclick = () => {
    document.querySelectorAll('#ssLib input[data-sspick]').forEach(b => {
      /** @type {HTMLInputElement} */ (b).checked = true;
    });
    ssPickSync();
  };
if ($('ssBulkNone'))
  /** @type {VEl} */ ($('ssBulkNone')).onclick = () => {
    document.querySelectorAll('#ssLib input[data-sspick]').forEach(b => {
      /** @type {HTMLInputElement} */ (b).checked = false;
    });
    ssPickSync();
  };

// Combine selected vocal material into the shared Speech library. This prepares source audio;
// it does not start training.
if ($('ssBulkImport'))
  /** @type {VEl} */ ($('ssBulkImport')).onclick = async () => {
    const on = ssPicked();
    if (!on.length) return;
    const rows = on.map(p => ss.lib.find(x => x.ref === p.ref)).filter(Boolean);
    if (!rows.some(r => r && (r.stems || []).some(stem => stem.stem === 'vocals' || stem.stem === 'lead_solo'))) {
      await modal('Nothing to add', 'None of the selected sets contains vocal audio.', [{ label: 'OK', class: 'primary', value: 1 }]);
      return;
    }
    const btn = /** @type {HTMLButtonElement} */ ($('ssBulkImport'));
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" style="margin:0"></span>';
    try {
      await jpost('/train/import_stems_joined', { refs: on.map(p => p.ref) });
      switchTab('voicestudio');
      switchStudioPanel('speech');
      await spLoadAll();
    } catch (err) {
      await modal('Could not add clips to Speech', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    } finally {
      btn.disabled = false;
      btn.innerHTML = 'Combine vocals into Speech';
    }
  };
if ($('ssBulkDel'))
  /** @type {VEl} */ ($('ssBulkDel')).onclick = async () => {
    const on = ssPicked();
    if (!on.length) return;
    const rows = /** @type {StemSet[]} */ (on.map(p => ss.lib.find(x => x.ref === p.ref)).filter(Boolean));
    const list =
      rows
        .slice(0, 12)
        .map(c => `<div>· ${esc(c.song)} <span class="muted small">${fmtSize(c.size || 0)}</span></div>`)
        .join('') + (rows.length > 12 ? `<div class="muted small">…and ${rows.length - 12} more</div>` : '');
    const ok = await modal(
      'Delete these stem sets?',
      `<div class="small muted" style="margin-bottom:8px">Deleting <b>${on.length}</b> set${on.length === 1 ? '' : 's'} — <b>${fmtSize(on.reduce((s, c) => s + c.size, 0))}</b> of WAV files.</div>
     <div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:6px 8px">${list}</div>`,
      [
        { label: 'Cancel', value: 0 },
        { label: '🗑 Delete', class: 'danger', value: 1 },
      ],
    );
    if (!ok) return;
    // 🔴 ONE REQUEST. `delete_sets` walks the list server-side and answers with the refs that
    // ACTUALLY went — a folder still held open reports as not deleted and keeps its row. Firing N
    // requests would give up that per-ref truth and lose the report with it.
    let deleted = [];
    try {
      const r = await fetch('/stems/library', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refs: on.map(p => p.ref) }),
      });
      deleted = (await r.json().catch(() => ({}))).deleted || [];
    } catch (e) {}
    if (deleted.length < on.length) {
      await modal(
        'Some sets were not deleted',
        `${deleted.length} of ${on.length} went. A set still open in a player can refuse to delete on Windows — close it and try again.`,
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
    }
    if (on.some(p => p.ref === ss.open)) ss.open = null;
    ssLoadLib();
  };

/** @param {string} ref */
function ssShowSplit(ref) {
  ss.open = ref;
  ssLoadLib();
}
/** @type {VEl} */ ($('ssLib')).addEventListener('click', async e => {
  // 🎓 a stem into the training pool — the LEAD on a set that has one, the wet vocal otherwise
  // (`ssTrainStem`, which is also what decides whether this button is rendered at all). Spins:
  // the stem is a WAV and gets encoded to MP3 on the way in, which on a full song is real
  // seconds of work.
  // ✂ 8.4-m2 — extract the lead from a set that was split some other way. The same job on
  // the same rails as the Split button: the only differences are that the song comes off the
  // ROW rather than the tray, and that stage 1 is a store hit, so Demucs does not run at all.
  const ex = /** @type {HTMLElement} */ (e.target).dataset.sslead;
  if (ex) {
    const c = ss.lib.find(x => x.ref === ex);
    if (!c || !c.song_ref) return;
    try {
      const r = await jpost('/stems/start', {
        song: c.song_ref,
        mode: 'lead',
        dereverb: /** @type {HTMLInputElement} */ ($('ssDereverb')).checked,
        params: ssLeadParams(),
        device: /** @type {HTMLSelectElement} */ ($('ssDevice')).value,
      });
      ss.jobId = r.job_id;
      ssStart = Date.now();
      /** @type {VEl} */ ($('ssLog')).innerHTML = '';
      ssLogLine(
        `Extracting the lead vocal from “${esc(c.song)}” — the vocal is already split, so this is the detection and the cut only.`,
        'muted',
      );
      ssSetRunning(true);
      ssStrip();
      ssOpenStream(r.job_id);
    } catch (err) {
      await modal(
        isHttpError(err) && err.status === 409 ? 'Already running' : 'Could not extract the lead',
        esc(/** @type {ErrLike} */ (err).message),
        [{ label: 'OK', class: 'primary', value: 1 }],
      );
    }
    return;
  }
  const addSpeech = /** @type {HTMLElement} */ (e.target).dataset.ssspeech;
  if (addSpeech) {
    const c = ss.lib.find(x => x.ref === addSpeech);
    if (!c) return;
    const stem = (c.stems || []).some(s => s.stem === 'lead_solo') ? 'lead_solo' : 'vocals';
    try {
      await jpost('/train/import_stem', { ref: addSpeech, stem });
      switchTab('voicestudio');
      switchStudioPanel('speech');
      await spLoadAll();
    } catch (err) {
      await modal('Could not add vocal to Speech', esc(/** @type {ErrLike} */ (err).message), [{ label: 'OK', class: 'primary', value: 1 }]);
    }
    return;
  }
  const del = /** @type {HTMLElement} */ (e.target).dataset.ssdel;
  if (del) {
    const c = ss.lib.find(x => x.ref === del);
    const ok = await modal(
      'Delete these stems?',
      `Delete the stems of <b>${esc(c ? c.song : del)}</b>${c ? ` (${STEM_MODE[c.mode] || c.mode})` : ''}?`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Delete', class: 'danger', value: 1 },
      ],
    );
    if (!ok) return;
    try {
      await fetch('/stems/library', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refs: [del] }),
      });
    } catch (e2) {}
    if (ss.open === del) ss.open = null;
    ssLoadLib();
    return;
  }
});
/** @type {VEl} */ ($('ssLibRefresh')).onclick = ssLoadLib;

// ── bring your own stems (§7) ──
function ssUpReady() {
  const f = /** @type {HTMLInputElement} */ ($('ssUpFiles')).files;
  /** @type {HTMLButtonElement} */ ($('ssUpGo')).disabled = !f || !f.length;
  /** @type {VEl} */ ($('ssUpNote')).innerHTML =
    f && f.length
      ? `<span class="muted">${f.length} file${f.length === 1 ? '' : 's'}: ${[...f].map(x => esc(x.name)).join(', ')}</span>`
      : '';
}
/** @type {VEl} */ ($('ssUpFiles')).addEventListener('change', ssUpReady);
/** @type {VEl} */ ($('ssUpGo')).onclick = async () => {
  const files = /** @type {HTMLInputElement} */ ($('ssUpFiles')).files;
  if (!files || !files.length) return;
  const btn = /** @type {HTMLButtonElement} */ ($('ssUpGo'));
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Uploading…';
  try {
    const fd = new FormData();
    fd.append('name', /** @type {HTMLInputElement} */ ($('ssUpName')).value.trim() || files[0].name.replace(/\.[^.]+$/, ''));
    for (const f of files) fd.append('file', f);
    const r = await fetchUnlocked('/stems/upload', { method: 'POST', body: fd });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    /** @type {HTMLInputElement} */ ($('ssUpFiles')).value = '';
    /** @type {HTMLInputElement} */ ($('ssUpName')).value = '';
    await ssLoadLib();
    ssShowSplit(j.ref);
    /** @type {HTMLDetailsElement} */ ($('ssUpWrap')).open = false;
    ssLogLine(
      `Stem set “${esc(j.song)}” uploaded — ${(j.stems || []).length} stem${(j.stems || []).length === 1 ? '' : 's'}${j.swappable ? '. Vocal audio is available in the set.' : '. No vocal was detected, but the set is kept.'}`,
      'ok',
    );
  } catch (e) {
    await modal('Upload failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Upload stem set';
    ssUpReady();
  }
};
// reload-reattach: a live split survives the page
export async function ssResume() {
  let live = [];
  try {
    live = (await jget('/stems/jobs')).filter(
      /** @type {(j:{status:string}) => boolean} */ (j => ['queued', 'running'].includes(j.status)),
    );
  } catch (e) {
    return;
  }
  if (!live.length) return;
  let st;
  try {
    st = await jget('/stems/status/' + live[live.length - 1].id);
  } catch (e) {
    return;
  }
  if (['done', 'failed', 'canceled'].includes(st.status)) return;
  ss.song = {
    ref: st.song,
    name: st.song_name,
    source: st.song.split('/')[0] === 'acestep' ? 'acestep' : 'uploads',
  };
  const r = document.querySelector(`input[name=ssMode][value="${st.mode}"]`);
  if (r) /** @type {HTMLInputElement} */ (r).checked = true;
  // The tick comes back from what the RUNNING job was given rather than from the checkbox's
  // default — `stems_status` carries `dereverb` for exactly this (web/stems.py). Guarded on
  // `!= null` for the same reason `vsCleanup` is (:1702): a job started before the field
  // existed must leave his tick alone, not clear it. The wrapper's visibility needs nothing
  // here — `ssSetRunning` below re-renders the tray, which reads the radio restored above.
  if (st.dereverb != null) /** @type {HTMLInputElement} */ ($('ssDereverb')).checked = !!st.dereverb;
  ssDeviceOptions();
  const ssDevR = /** @type {HTMLSelectElement} */ ($('ssDevice'));
  if ([...ssDevR.options].some(o => o.value === st.device)) ssDevR.value = st.device;
  switchTab('voicestudio');
  switchStudioPanel('stems');
  /** @type {VEl} */ ($('ssLog')).innerHTML = '';
  ssLogLine('Reconnected to the split in progress…', 'muted');
  ssStart = st.started_at ? Date.now() - Math.max(0, st.now - st.started_at) * 1000 : Date.now();
  ss.jobId = st.id;
  ssSetRunning(true);
  if (st.canceling) {
    /** @type {HTMLButtonElement} */ ($('ssCancel')).disabled = true;
    /** @type {VEl} */ ($('ssCancel')).innerHTML = '<span class="spin"></span>Canceling…';
  }
  ssOpenStream(st.id);
}


// ── 8.9.14: the folder controls on Stems ▸ 🎵 Songs ──────────────────────────
//
// 🔴 THE SAME SCOPE AS VOICE SWAP ▸ SOURCES, BECAUSE IT IS THE SAME DATA. `index.html` says so to
// the user in bold — "This is the same list as Voice Swap ▸ Sources, which reads the same store" —
// and `src/folders.py` names both panels against `voiceswap_songs`. Only one of the two had
// folders, so a song filed in Voice Swap showed up here unfiled and unmovable, which reads as the
// filing having been lost. Scope is the DATASET, not the panel; this is that rule being honored
// rather than a second set of folders being invented.
//
// ⚠️ ONE HOST, ONE SCOPE — no resolver needed here. `#vsPicker` needs `scopeOf` because it swaps
// between two DIFFERENT scopes under one element; `#ssPicker` only ever shows songs.
/** @param {string} act */
const ssPickerFolderReload = async act => {
  if (act === 'move') ss.srcSel.clear(); // the ticked songs went where they were sent
  // `open` is pure UI state and `create` has already refreshed the folder cache inside
  // `folderCreate`, so neither needs a round trip. Everything else — move, rename, del —
  // invalidates the server's `.folder` stamps and MUST refetch: re-rendering from the rows in hand
  // paints them straight back into the folder they were just taken out of.
  if (act === 'open' || act === 'create') ssRenderPicker();
  else await ssLoadSongs();
};
folderAddButton(VSS_SCOPE, 'ssPickerRefresh', ssPickerFolderReload, { selected: () => [...ss.srcSel] });
folderWire('ssPicker', VSS_SCOPE, {
  reload: ssPickerFolderReload,
  selected: () => [...ss.srcSel],
  // Counted over every song this panel holds, not just the page — the number goes into the
  // delete-folder confirm ("the N items in it are kept"), which must describe the folder rather
  // than the current view of it.
  counts: () => {
    /** @type {Record<string, number>} */
    const n = {};
    for (const s of ss.songs || []) if (s.folder) n[s.folder] = (n[s.folder] || 0) + 1;
    return n;
  },
});
folderWireDrag('ssPicker', VSS_SCOPE, { reload: ssPickerFolderReload, selected: () => [...ss.srcSel] });


// ── 8.9: the folder controls on Stems ▸ Your stems ───────────────────────────
//
// 🔴 THE TICKS ARE READ OFF THE DOM (`ssPicked`), WHICH IS THE HONEST SET HERE and not an
// oversight. That same tick set feeds `🗑 Delete selected` over gigabytes of separations, and
// this panel has always read it from the checkboxes rather than from a Set precisely so that
// only rows he can currently SEE can be acted on. Folders inherit that: a row inside a CLOSED
// folder is not rendered, so it cannot be ticked, so it cannot be moved by mistake either.
//
// 🔴 8.9.14 — AND THE TICKS ARE CLEARED AFTER A MOVE, BECAUSE "a reload rebuilds them unticked"
// STOPPED BEING TRUE AT 8.6.1. This comment used to say the opposite and used it to justify
// leaving them: the set lives on the checkboxes, so a reload was thought to wipe it. It does not,
// because this list is RECONCILED rather than repainted, and a set's row HTML does not mention
// its folder — `ssOneSet` only ever carries `folderTag` when a FILTER is flattening the list. So
// filing or un-filing produces a byte-identical `__sig`, `reconcile` keeps the existing element
// (it only repositions it), and a checkbox's live `checked` property survives being moved.
//
// The result was the one shape this panel must never have: tick three sets, press
// `⇤ Remove from folder`, and they land back at the root STILL TICKED with `🗑 Delete selected`
// live above them, reading "3 sets selected · N GB to reclaim" — a selection the user believes
// they already spent, aimed at the one button here that costs gigabytes and cannot be undone.
// Voice Swap ▸ Sources spells out the same rule for the same reason: filing is reversible and
// deleting is not.
//
// ⚠️ THE CLEAR MUST RUN AFTER THE RELOAD, not before — the elements survive it, so a clear that
// ran first would simply be undone. And `ssPickSync()` has to follow, or `#ssBulk` stays open
// over an empty selection.
/** @param {string} act */
const ssFolderReload = async act => {
  if (act === 'open') ssRenderLib();
  else await ssLoadLib();
  if (act !== 'move') return;
  document.querySelectorAll('#ssLib input[data-sspick]').forEach(b => {
    /** @type {HTMLInputElement} */ (b).checked = false;
  });
  ssPickSync();
};
// `ssLoadLib` refetches, which is what an un-file needs — a bare `ssRenderLib()` would paint the
// rows back into the folder they were just taken out of, from their own stale `.folder` stamps.
folderAddButton(SSL_SCOPE, 'ssLibRefresh', ssFolderReload, { selected: () => ssPicked().map(x => x.ref) });
folderWire('ssLib', SSL_SCOPE, {
  reload: ssFolderReload,
  selected: () => ssPicked().map(x => x.ref),
  counts: () => {
    /** @type {Record<string, number>} */
    const n = {};
    for (const c of ss.lib || []) if (c.folder) n[c.folder] = (n[c.folder] || 0) + 1;
    return n;
  },
});
folderWireDrag('ssLib', SSL_SCOPE, {
  reload: async () => ssLoadLib(),
  selected: () => ssPicked().map(x => x.ref),
});
