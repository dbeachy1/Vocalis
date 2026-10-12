// media/bulk.js — the Bulk tab (7.3-m4h): one-shot batch enhance or clean-up → a single ZIP → gone.
//
// Moved verbatim from index.html's `── Bulk (4.5) ──` banner. 312 lines, one cut, and the cleanest
// boundary left in the page: 160 mentions of a `blk*` identifier in the inline script and NOT ONE of
// them outside this range.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS EXPORTED — one name.
//
//   loadBulk    the tab's entry point. Its only caller is `switchTab`: `if(name==='bulk')loadBulk();`
//               — a CALL, inside a function, so nothing here is parse-time reachable (§3.1).
//
// 🔴 EVERYTHING ELSE IS MODULE-PRIVATE, AND TWO OF THEM COULD NOT BE PUBLISHED EVEN IF SOMETHING
// WANTED THEM. `blkStart` and `blkMode` are a `let` pair that this file's own code reassigns —
// `blkSetMode` writes `blkMode` on every tab click — and §11.4's rule is that `Object.assign(window,
// mod)` copies a VALUE once at module load. Publishing either would pin an inline reader at
// 'cleanup' for the life of the page. They stay in here, where the only readers are.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT REACHES FOR AS AN INLINE GLOBAL — exactly one name, `UIS`.
//
// The account-local, server-side UI-state store, a top-level `const` in index.html that CANNOT be
// modularized at all (§11.2). A module reads it through the scope chain, the same way
// js/voice/autoplay.js does for the same reason.
//
// ⚠️ AND ITS ONE PARSE-TIME READ MOVES LATER, WHICH IS THE SAFE DIRECTION. Restoring the remembered
// mode used to happen while the page was still parsing; it now happens at module evaluation. That
// is still before `main.js` boots — the shim's `await import('/webui/js/main.js')` is the last
// statement in the block, below every static import — so `blkMode` is restored before `switchTab`
// can reach `loadBulk`, which is the only thing that reads it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// 📌 IT WIRES AT MODULE LOAD, so importing it is load-bearing beyond the one name it publishes:
// #blkModeTabs, #blkFiles, #blkGo, #blkCancel, #blkDownload, #blkToEnhance and #blkClear all get
// their handlers from this file's top level. Drop the import and there is no ReferenceError — just
// a Bulk tab whose every button is dead, which is the failure mode js/sys/comfy.js's header warns
// about and the reason this one is on the shim's import list rather than only in main.js.
//
// ⚠️ TWO STATES, ONE PANEL. §5b split every piece of
// per-mode memory into `BLKW` because Enhance and Clean up shared one staged list, one last-batch
// panel and one log, so each tab showed the other's. Anything a tab remembers goes
// in that bucket and `blkApplyMode()` repaints from whichever is active. A new piece of tab state
// added anywhere else re-creates the bug exactly.

import { $, esc } from '../util/dom.js';
import { UIS } from '../util/uistate.js'; // 7.3-m13
import { jget, jpost, fetchUnlocked } from '../util/http.js';
import { fmtSize } from '../util/fmt.js';
import { modal } from '../ui/modal.js';
import { logInto } from '../ui/log.js';
// 🔴 `enh` — the ENHANCE CAPABILITY OBJECT — was used by `loadBulk` at :222/:223 and never
// imported, so the first visit to the Bulk tab threw on a free name and the steps dropdown was
// never populated. `#blkNfe` ships with no options, so the guard in front of it is true on a cold
// load and the throw is unconditional.
// 🔴 AND THIS ONE HID BEHIND A NAME COLLISION, WHICH IS WHY A READER MISSES IT. Three functions in
// this file declare their OWN `const enh = blkMode==='enhance'` — a BOOLEAN — at :169, :262 and
// :319. So `enh` reads as locally defined almost everywhere you look, and `loadBulk`, which has no
// such local, is the one place it is not. ⚠️ Those three shadows are legal and still shadow this
// import inside their own bodies: a future `enh.choices` added to any of them silently reads
// `.choices` off a boolean and gets `undefined` rather than throwing. Found by the 7.3 review.
import { enh } from '../sys/enhance.js';
// ── Bulk (4.5): one-shot batch enhance → single ZIP → gone ───────────────────
// Three states in one panel — setup (pick files) / running (live log + N-of-M) / done
// (the last-batch panel: summary, Download, Clear). The lifecycle rides the same SSE rails
// as every other job; only-ever-one batch, so there is no list to manage.
/** @typedef {'enhance'|'cleanup'} BlkMode */
/** A staged file, mirrored from this mode's server-side staging folder (§5a).
 * @typedef {object} BlkStagedFile
 * @property {string} name
 * @property {number} [size]
 */
/**
 * The Bulk tab's finished-batch summary — `/bulk/current/<mode>`'s answer, `job_done`'s SSE
 * event, and what `blkRenderDone` renders from.
 * ⚠️ `count` IS OPTIONAL ON THE TYPE ONLY because `loadBulk` reads `/bulk/current/<mode>` into a
 * `{}` sentinel before the fetch resolves — a real manifest always carries every field below.
 * @typedef {object} BlkManifest
 * @property {number} [count]
 * @property {number} [size]
 * @property {BlkMode} [mode]
 * @property {string} [format]
 * @property {string} [format_label]
 * @property {string[]} [names]
 * @property {boolean} [has_result]
 */
/**
 * @typedef {object} BlkState
 * @property {string|null} jobId
 * @property {EventSource|null} es
 * @property {number} total
 * @property {number} done
 * @property {BlkMode} mode
 * @property {boolean} avail
 * @property {boolean} cleanupAvail
 * @property {number} cardCount
 * @property {string} enhMsg
 * @property {string} cleanupMsg
 * @property {boolean} staging   An upload is in flight; ▶ stays disabled until it lands.
 */
/** @type {BlkState} */
const blk = {
  jobId: null,
  es: null,
  total: 0,
  done: 0,
  mode: 'enhance',
  avail: true,
  cleanupAvail: true,
  cardCount: 0,
  enhMsg: '',
  cleanupMsg: '',
  staging: false,
};
// PER-MODE workspace state (§5b). Enhance and Clean up shared one staged list, one last-batch
// panel and one log, so each tab showed the other's. Everything a tab remembers
// lives in its own bucket here and blkApplyMode() repaints the panel from whichever is active.
//   staged — mirror of THIS mode's staging FOLDER on the server; never a local guess
//   view   — 'setup' | 'running' | 'done', so switching tabs mid-run doesn't lose either
//   log    — the log HTML, kept per mode (there's one #blkLog element, swapped on switch)
/**
 * @typedef {object} BlkModeState
 * @property {BlkStagedFile[]} staged
 * @property {'setup'|'running'|'done'} view
 * @property {string} log
 * @property {BlkManifest|null} manifest
 * @property {number} start
 */
/** @type {Record<BlkMode, BlkModeState>} */
const BLKW = {
  enhance: { staged: [], view: 'setup', log: '', manifest: null, start: 0 },
  cleanup: { staged: [], view: 'setup', log: '', manifest: null, start: 0 },
};
const blkW = () => BLKW[blkMode];
// A fresh browser lands on Clean up — step 1 of the chain. localStorage still
// wins once you've picked a tab, so this only decides where a first-time visit starts.
let blkStart = 0;
/** @type {BlkMode} */
let blkMode = 'cleanup';
/** @type {Record<BlkMode,string>} */
const BLK_BLURB = {
  enhance:
    '<b>Bulk Enhance</b> enhances each file across your GPUs — the same AI upscaling the Book and Playground Enhance do, run over a whole pile at once (e.g. an old render’s chapters you want brought to full band without adopting them as clips).',
  cleanup:
    '<b>Bulk Clean up</b> runs DeepFilterNet3 denoise on each file — the same clean-up the Speech tab does, over a whole pile. It runs on the <b>CPU</b>, so it never competes with a render for a card.',
};
/** @param {string} html
 * @param {string} [cls] */
function blkLogLine(html, cls) {
  logInto(/** @type {VEl} */ ($('blkLog')), html, cls, /** @type {HTMLInputElement} */ ($('blkAutoscroll')).checked);
}
function blkElapsed() {
  const s = Math.floor((Date.now() - blkStart) / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}
// blkShow records the view on the ACTIVE mode's bucket, so switching tabs and coming back
// restores whatever that tab was showing (§5b) instead of resetting it to setup.
/** @param {'setup'|'running'|'done'} state */
function blkShow(state) {
  blkW().view = state;
  /** @type {VEl} */ ($('blkSetup')).style.display = state === 'setup' ? '' : 'none';
  /** @type {VEl} */ ($('blkRunning')).style.display = state === 'running' ? '' : 'none';
  /** @type {VEl} */ ($('blkDone')).style.display = state === 'done' ? '' : 'none';
}
function blkModeAvail() {
  return blkMode === 'cleanup' ? blk.cleanupAvail !== false : blk.avail !== false;
}
// The STAGED list (§5a). blkW().staged is a mirror of THIS MODE's staging FOLDER — never a
// local guess: every mutation returns the new list and we repaint from that, so the screen
// can't drift from what a run would actually process.
function blkReady() {
  const n = (blkW().staged || []).length;
  /** @type {HTMLButtonElement} */ ($('blkGo')).disabled = !blkModeAvail() || !n || blk.staging;
  /** @type {VEl} */ ($('blkPick')).innerHTML = n ? `${n} file${n === 1 ? '' : 's'} staged` : '';
  // Stands in for the browser's "No file chosen" (hidden in CSS) — it counts what is STAGED,
  // which is the thing a run actually processes, not what the cleared input remembers.
  /** @type {VEl} */ ($('blkChosen')).textContent = n ? `${n} file${n === 1 ? '' : 's'} chosen` : 'No files chosen';
}
function blkRenderStaged() {
  const rows = blkW().staged || [];
  if (!rows.length) {
    /** @type {VEl} */ ($('blkStaged')).innerHTML = '';
    blkReady();
    return;
  }
  /** @type {VEl} */ ($('blkStaged')).innerHTML =
    `<div class="small" style="border:1px solid var(--line);border-radius:6px;overflow:hidden">` +
    rows
      .map(
        r => `<div class="blkrow" style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--line)">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.name)}">${esc(r.name)}</span>
        <span class="muted" style="flex:0 0 auto">${fmtSize(r.size)}</span>
        <button class="blkx" data-name="${esc(r.name)}" title="Remove ${esc(r.name)}" style="flex:0 0 auto;background:none;border:none;color:var(--err);cursor:pointer;font-size:1.071429rem;line-height:1;padding:2px 4px">✕</button>
      </div>`,
      )
      .join('') +
    `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px">
        <span class="muted" style="flex:1">${rows.length} file${rows.length === 1 ? '' : 's'} · ${fmtSize(rows.reduce((a, r) => a + (r.size || 0), 0))}</span>
        <button id="blkClearStaged" class="sm danger" style="flex:0 0 auto">Remove all</button>
      </div></div>`;
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.blkx')).forEach(
    b => (b.onclick = () => blkStageRemove(/** @type {string} */ (b.dataset.name))),
  );
  /** @type {VEl} */ ($('blkClearStaged')).onclick = blkStageClear;
  blkReady();
}
// Every staging call names its mode in the URL, and the reply is written to THAT mode's bucket
// — captured up front, because an await can land after the user has switched tabs and writing
// the reply to whatever is active by then would put one tab's files in the other's list.
/** @param {BlkMode} [mode] */
async function blkLoadStaged(mode) {
  const m = mode || blkMode;
  try {
    BLKW[m].staged = await jget('/bulk/stage/' + m);
  } catch (e) {
    BLKW[m].staged = [];
  }
  if (m === blkMode) blkRenderStaged();
}
/** @param {string} name */
async function blkStageRemove(name) {
  const m = blkMode;
  try {
    BLKW[m].staged = await jpost(`/bulk/stage/${m}/remove`, { name });
  } catch (e) {
    await blkLoadStaged(m);
    return;
  }
  if (m === blkMode) blkRenderStaged();
}
async function blkStageClear() {
  const m = blkMode;
  try {
    const r = await jpost(`/bulk/stage/${m}/clear`, {});
    BLKW[m].staged = r.files || [];
  } catch (e) {
    await blkLoadStaged(m);
    return;
  }
  if (m === blkMode) blkRenderStaged();
}
// Picked files upload IMMEDIATELY — that's what makes them survive a reload. The input is
// cleared afterward so re-picking the SAME file fires 'change' again (a browser won't
// re-fire it for an unchanged value), and so the native "3 files" label can't contradict
// the staged list, which is the real one.
async function blkStagePick() {
  const f = /** @type {HTMLInputElement} */ ($('blkFiles')).files;
  if (!f || !f.length) return;
  const m = blkMode; // the tab these files were picked FOR — see blkLoadStaged
  const fd = new FormData();
  for (const x of f) fd.append('file', x);
  /** @type {HTMLInputElement} */ ($('blkFiles')).value = '';
  blk.staging = true;
  blkReady();
  /** @type {VEl} */ ($('blkStageNote')).innerHTML = `<span class="spin"></span>Uploading ${f.length} file${f.length === 1 ? '' : 's'}…`;
  try {
    const r = await fetchUnlocked('/bulk/stage/' + m, { method: 'POST', body: fd });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    BLKW[m].staged = j;
  } catch (e) {
    await modal('Could not stage the files', esc(/** @type {ErrLike} */ (e).message || String(e)), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    await blkLoadStaged(m);
  } finally {
    blk.staging = false;
    /** @type {VEl} */ ($('blkStageNote')).textContent =
      'Files upload as you pick them and stay here until you run or remove them — picking more adds to the list.';
    blkRenderStaged();
  }
}
function blkSelectedCards() {
  return [...document.querySelectorAll('.blkchk:checked')].map(x => /** @type {HTMLInputElement} */ (x).value).join(',');
}
/**
 * `/bulk/info`'s answer — availability per mode, plus which local cards Enhance can spread over.
 * @typedef {object} BulkInfo
 * @property {boolean} [available]
 * @property {boolean} [cleanup_available]
 * @property {string} [message]
 * @property {string} [cleanup_message]
 * @property {{index:number,name:string}[]} [cards]
 */
async function blkLoadInfo() {
  /** @type {BulkInfo|null} */
  let info = null;
  try {
    info = await jget('/bulk/info');
  } catch (e) {}
  if (!info) {
    /** @type {VEl} */ ($('blkCardsWrap')).style.display = 'none';
    return;
  }
  blk.avail = !!info.available;
  blk.cleanupAvail = !!info.cleanup_available;
  blk.enhMsg = info.message || '';
  blk.cleanupMsg = info.cleanup_message || '';
  const cards = info.cards || [];
  blk.cardCount = cards.length;
  /** @type {VEl} */ ($('blkCards')).innerHTML = cards
    .map(
      c =>
        `<label class="gpu" style="display:inline-flex;align-items:center;gap:6px;margin-right:14px"><input type="checkbox" class="blkchk" value="${c.index}" checked> cuda:${c.index} — ${esc(c.name)}</label>`,
    )
    .join('');
  blkApplyMode();
}
// Enhance vs Clean up: swap engine, hide the GPU picker + Steps for Clean up (it's CPU), and
// swap the format default (256k for Enhance; Match source for Clean up — a denoise adds no band).
function blkApplyMode() {
  const enh = blkMode === 'enhance';
  document
    .querySelectorAll('#blkModeTabs button')
    .forEach(b => b.classList.toggle('active', /** @type {HTMLButtonElement} */ (b).dataset.blkmode === blkMode));
  /** @type {VEl} */ ($('blkModeBlurb')).innerHTML = BLK_BLURB[blkMode];
  /** @type {VEl} */ ($('blkNfeWrap')).style.display = enh ? '' : 'none';
  /** @type {VEl} */ ($('blkCardsWrap')).style.display = enh && blk.avail && blk.cardCount > 1 ? '' : 'none';
  /** @type {VEl} */ ($('blkSourceOpt')).style.display = enh ? 'none' : '';
  // BOTH modes default to the RECOMMENDED option, so the tag and the selection never disagree.
  // Clean up keeps 'Match source' selectable — it just isn't preselected any
  // more: a cleaned clip's destination is voicetrain, which writes MP3 regardless, so landing a
  // lossless WAV by default only inflates the ZIP for a file that gets re-encoded downstream.
  /** @type {HTMLSelectElement} */ ($('blkFormat')).value = 'mp3_256k';
  /** @type {VEl} */ ($('blkMono')).innerHTML = enh
    ? 'Enhanced output is <b>mono</b> — the AI speech model rebuilds a single voice channel, so stereo isn’t available. A render you start elsewhere takes priority and the batch waits, then resumes.'
    : 'Pick <b>Match source</b> to avoid a re-encode (MP3 stays MP3 at its own bitrate, anything else lands as WAV) — a denoise adds no bandwidth, so it costs nothing but size. Runs on the CPU, so it competes with nothing.';
  /** @type {VEl} */ ($('blkGo')).textContent = enh ? '▶ Enhance batch' : '▶ Clean up batch';
  const avail = blkModeAvail(),
    msg = enh ? blk.enhMsg : blk.cleanupMsg;
  /** @type {VEl} */ ($('blkGoNote')).innerHTML = avail
    ? ''
    : `<span style="color:var(--warn)">${esc(msg || 'Unavailable on this box.')}</span>`;
  // Repaint the whole panel from THIS mode's bucket (§5b) — staged list, log, and which of the
  // three views it was left on. Without this the tabs share whatever the last one rendered,
  // which is how Enhance ended up offering a ZIP of cleaned files.
  const w = blkW();
  blkRenderStaged();
  /** @type {VEl} */ ($('blkLog')).innerHTML =
    w.log || '<span class="muted ph">Pick some files and press ' + (enh ? 'Enhance' : 'Clean up') + ' to begin.</span>';
  blkStart = w.start || 0;
  if (w.view === 'done' && w.manifest) blkRenderDone(w.manifest);
  else if (w.view === 'running') blkShow('running');
  else blkShow('setup');
  blkReady();
}
// Switching tabs saves the log HTML on the mode we're LEAVING (one #blkLog element serves both),
// then blkApplyMode paints the one we're entering.
/** @param {BlkMode} m */
function blkSetMode(m) {
  if (m === blkMode) return;
  blkW().log = /** @type {VEl} */ ($('blkLog')).innerHTML;
  blkW().start = blkStart;
  blkMode = m;
  try {
    UIS.setItem('vocalis-blkmode', m);
  } catch (e) {} // 🔴 UIS — see switchStTab
  blkApplyMode();
  blkLoadStaged(m);
}
// The markup's only two `data-blkmode` values are 'cleanup' and 'enhance' (index.html's
// `#blkModeTabs`) — cast rather than widen `blkSetMode` to `string`, since every OTHER caller
// passes a real `BlkMode` and a wider parameter would stop catching a typo'd third mode there.
/** @type {VEl} */ ($('blkModeTabs')).addEventListener('click', e => {
  if (/** @type {HTMLElement} */ (e.target).dataset.blkmode)
    blkSetMode(/** @type {BlkMode} */ (/** @type {HTMLElement} */ (e.target).dataset.blkmode));
});
try {
  const m = UIS.getItem('vocalis-blkmode');
  if (m === 'cleanup' || m === 'enhance') blkMode = m;
} catch (e) {}
function blkProgress() {
  const pct = blk.total ? Math.round((blk.done / blk.total) * 100) : 0;
  const fill = /** @type {VEl} */ ($('blkProgFill'));
  fill.classList.remove('indet');
  fill.style.width = pct + '%';
  /** @type {VEl} */ ($('blkProgPct')).textContent = blk.total ? pct + '%' : '';
  /** @type {VEl} */ ($('blkProgLabel')).textContent =
    `${blk.done}/${blk.total} ${blk.mode === 'cleanup' ? 'cleaned' : 'enhanced'} · elapsed ${blkElapsed()}`;
}
function blkZipping() {
  const fill = /** @type {VEl} */ ($('blkProgFill'));
  fill.classList.add('indet');
  fill.style.width = '';
  /** @type {VEl} */ ($('blkProgPct')).textContent = '';
  /** @type {VEl} */ ($('blkProgLabel')).textContent = `zipping ${blk.total} file${blk.total === 1 ? '' : 's'}…`;
}
/** @param {BlkManifest} m */
function blkRenderDone(m) {
  blkW().manifest = m; // remembered per mode, so a tab switch can repaint it
  blkShow('done');
  // The hand-off is Clean up's only — and it needs a ZIP to read, so it dies with the result.
  /** @type {VEl} */ ($('blkToEnhanceWrap')).style.display = blkMode === 'cleanup' && m.has_result !== false ? '' : 'none';
  const modeLabel = m.mode === 'cleanup' ? 'Cleaned up' : 'Enhanced';
  /** @type {VEl} */ ($('blkSummary')).innerHTML =
    `<b>${modeLabel}</b> · ${esc(m.format_label || m.format || '')} · <b>${m.count}</b> file${m.count === 1 ? '' : 's'} · ${fmtSize(m.size)}`;
  /** @type {VEl} */ ($('blkNames')).innerHTML = (m.names || []).map(n => esc(n)).join('<br>') || '<span class="muted">—</span>';
  /** @type {HTMLButtonElement} */ ($('blkDownload')).disabled = m.has_result === false;
}
/** @type {VEl} */ ($('blkFiles')).addEventListener('change', blkStagePick);

export async function loadBulk() {
  if ($('blkNfe') && !(/** @type {HTMLSelectElement} */ ($('blkNfe')).options.length) && enh.choices)
    /** @type {VEl} */ ($('blkNfe')).innerHTML = enh.choices
      .map(n => `<option value="${n}"${n === enh.def ? ' selected' : ''}>${n} steps</option>`)
      .join('');
  blkLoadInfo();
  // Read BOTH modes' staging folders and last batches (§5a/§5b) — each tab must be right the
  // moment you switch to it, not only once you've visited it.
  /** @type {BlkMode[]} */
  const modes = ['enhance', 'cleanup'];
  await Promise.all(modes.map(m => blkLoadStaged(m)));
  for (const m of modes) {
    /** @type {BlkManifest} */
    let cur = {};
    try {
      cur = await jget('/bulk/current/' + m);
    } catch (e) {}
    BLKW[m].manifest = cur && cur.count ? cur : null;
    if (BLKW[m].manifest) BLKW[m].view = 'done';
  }
  // A live batch survives the page — reattach to it. Otherwise show the last batch, or setup.
  /** @type {{id:string,status:string}[]} */
  let jobs = [];
  try {
    jobs = await jget('/bulk/jobs');
  } catch (e) {}
  const running = (jobs || []).find(j => j.status === 'queued' || j.status === 'running');
  if (running) {
    if (blk.jobId !== running.id) blkReattach(running.id);
    return;
  }
  if (blk.jobId) return; // an in-tab running view we shouldn't clobber
  blkApplyMode();
} // paints the ACTIVE mode from its own bucket

/** @param {string} id */
async function blkReattach(id) {
  let st;
  try {
    st = await jget('/bulk/status/' + id);
  } catch (e) {
    return;
  }
  if (['done', 'failed', 'canceled'].includes(st.status)) {
    if (st.status === 'done') blkRenderDone(st.manifest || {});
    else blkShow('setup');
    return;
  }
  // A running batch belongs to ONE mode. Switch to its tab before painting the running view —
  // otherwise blkShow would mark whichever tab happens to be open as the one that's running (§5b).
  if (st.mode && st.mode !== blkMode) blkSetMode(st.mode);
  blk.jobId = id;
  blk.total = st.total;
  blk.done = st.done;
  blk.mode = st.mode;
  blkStart = st.started_at ? Date.now() - Math.max(0, st.now - st.started_at) * 1000 : Date.now();
  blkShow('running');
  /** @type {VEl} */ ($('blkLog')).innerHTML = '';
  blkLogLine('Reconnected to the batch in progress…', 'muted');
  if (st.stage === 'zipping') blkZipping();
  else blkProgress();
  if (st.canceling) {
    /** @type {HTMLButtonElement} */ ($('blkCancel')).disabled = true;
    /** @type {VEl} */ ($('blkCancel')).innerHTML = '<span class="spin"></span>Canceling…';
  } else {
    /** @type {HTMLButtonElement} */ ($('blkCancel')).disabled = false;
    /** @type {VEl} */ ($('blkCancel')).innerHTML = '■ Cancel';
  }
  blkOpenStream(id);
}

/** @type {VEl} */ ($('blkGo')).onclick = async () => {
  if (!(blkW().staged || []).length) return; // the STAGED list is the batch now, not the input
  const enh = blkMode === 'enhance';
  const cards = blkSelectedCards();
  if (enh && [...document.querySelectorAll('.blkchk')].length && !cards) {
    await modal('No GPU selected', 'Tick at least one GPU for the batch, or leave a card free by unticking just that one.', [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
    return;
  }
  const btn = /** @type {HTMLButtonElement} */ ($('blkGo'));
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Starting…';
  try {
    // No file parts: the files are already on the server. The route reads the staging area.
    const fd = new FormData();
    fd.append('format', /** @type {HTMLSelectElement} */ ($('blkFormat')).value);
    if (enh) {
      fd.append('nfe', /** @type {HTMLSelectElement} */ ($('blkNfe')).value || '');
      fd.append('cards', cards);
    }
    const r = await fetchUnlocked('/bulk/' + blkMode, { method: 'POST', body: fd });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    blk.jobId = j.job_id;
    blk.total = j.total;
    blk.done = 0;
    blk.mode = blkMode;
    blkStart = Date.now();
    /** @type {VEl} */ ($('blkLog')).innerHTML = '';
    blkLogLine(
      `${enh ? 'Enhancing' : 'Cleaning up'} ${j.total} file${j.total === 1 ? '' : 's'}${j.eta ? ` — ${esc(j.eta)}` : ''}…`,
      'muted',
    );
    blkShow('running');
    blkProgress();
    /** @type {HTMLButtonElement} */ ($('blkCancel')).disabled = false;
    /** @type {VEl} */ ($('blkCancel')).innerHTML = '■ Cancel';
    blkOpenStream(j.job_id);
  } catch (e) {
    await modal('Batch failed', esc(/** @type {ErrLike} */ (e).message), [{ label: 'OK', class: 'primary', value: 1 }]);
  } finally {
    btn.disabled = false;
    btn.innerHTML = blkMode === 'enhance' ? '▶ Enhance batch' : '▶ Clean up batch';
    blkReady();
  }
};

/** @type {VEl} */ ($('blkCancel')).onclick = async () => {
  if (!blk.jobId) return;
  /** @type {HTMLButtonElement} */ ($('blkCancel')).disabled = true;
  /** @type {VEl} */ ($('blkCancel')).innerHTML = '<span class="spin"></span>Canceling…';
  try {
    await jpost('/bulk/cancel/' + blk.jobId, {});
  } catch (e) {}
};

/** @type {VEl} */ ($('blkDownload')).onclick = () => {
  window.location.href = '/bulk/download/' + blkMode;
}; // this tab's ZIP (§5b)

// ▸ Copy to Enhance (§5c): the cleaned OUTPUTS become Enhance's staged inputs. Server-side copy
// (it extracts our own result.zip — §8 already deleted the loose outputs), so it's quick, but it
// still gets a spinner and a disabled button: it REPLACES what Enhance had staged, and a
// double-click that half-replaces a list is exactly the kind of thing this tab keeps getting bitten by.
/** @type {VEl} */ ($('blkToEnhance')).onclick = async () => {
  const btn = /** @type {HTMLButtonElement} */ ($('blkToEnhance'));
  const already = (BLKW.enhance.staged || []).length;
  if (already) {
    const ok = await modal(
      'Replace what Enhance has staged?',
      `Enhance already has <b>${already}</b> file${already === 1 ? '' : 's'} staged. Copying these cleaned files over will <b>delete</b> ${already === 1 ? 'it' : 'them'} first — they'd have to be uploaded again.`,
      [
        { label: 'Cancel', value: 0 },
        { label: 'Replace', class: 'danger', value: 1 },
      ],
    );
    if (!ok) return;
  }
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>Copying…';
  try {
    const r = await jpost('/bulk/handoff/cleanup-to-enhance', {});
    BLKW.enhance.staged = r.files || [];
    // Land on Enhance with its log explaining why it's suddenly full — the line goes in ENHANCE's
    // log (§5b made them per-mode), because that's the tab you're about to be looking at.
    BLKW.enhance.view = 'setup';
    blkSetMode('enhance');
    blkLogLine(`▸ ${r.count} file${r.count === 1 ? '' : 's'} copied from Clean up — ready to enhance.`, 'ok');
  } catch (e) {
    await modal('Could not copy to Enhance', esc(/** @type {ErrLike} */ (e).message || String(e)), [
      { label: 'OK', class: 'primary', value: 1 },
    ]);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

/** @type {VEl} */ ($('blkClear')).onclick = async () => {
  const m = blkMode,
    enh = m === 'enhance';
  const ok = await modal(
    `Clear the last ${enh ? 'Enhance' : 'Clean up'} batch?`,
    `This deletes that ZIP. The other tab's batch and your staged files are untouched.`,
    [
      { label: 'Cancel', value: 0 },
      { label: 'Clear', class: 'danger', value: 1 },
    ],
  );
  if (!ok) return;
  try {
    await jpost('/bulk/reset/' + m, {});
  } catch (e) {} // only THIS mode's batch (§5b)
  BLKW[m].manifest = null;
  BLKW[m].log = '';
  /** @type {VEl} */ ($('blkLog')).innerHTML =
    `<span class="muted ph">Pick some files and press ${enh ? 'Enhance' : 'Clean up'} to begin.</span>`;
  // Clear drops the ZIP, NOT your staged files (they're a separate thing — 'Remove all' is
  // theirs). Re-read the folder rather than trusting the mirror: another tab may have changed it.
  blkShow('setup');
  await blkLoadStaged(m);
};

// CLOSE the stream when the batch ends — every other tab has this (endJob / vsEndJob / ssEndJob /
// vtEndJob) and Bulk was the one that didn't; it only nulled blk.es.
//
// That is not cosmetic. _job_sse REPLAYS the whole event ring buffer (EVENT_CAP = 5000) to every
// connection and then RETURNS at the terminal event. So an unclosed EventSource sees the stream
// end, auto-reconnects ~1s later, and gets the entire log replayed — for ever. The symptoms
// The log re-filling once a second made a finished batch look like it was
// still running, and the panel flipping back to Choose Files each time the replayed job_done /
// canceled event re-fired the view switch. onerror cannot police it either — it early-returns on
// `blk.es!==es`, which is exactly what nulling blk.es made true.
// TWO separate things, and conflating them broke Cancel (4.6-m6, fixed in m7):
//   blkCloseStream() — drop the connection. Says nothing about whether the batch is over.
//   blkEndJob()      — the batch is over: close the stream AND forget which job it was.
// blkOpenStream must only ever CLOSE. It used to call blkEndJob(), which nulled the blk.jobId its
// own caller had set one line earlier — and Cancel starts `if(!blk.jobId)return;`, so the button
// became a silent no-op with nothing in the console.
function blkCloseStream() {
  if (blk.es) {
    try {
      blk.es.close();
    } catch (e) {}
    blk.es = null;
  }
}
function blkEndJob() {
  blkCloseStream();
  blk.jobId = null;
}
/** @param {string} id */
function blkOpenStream(id) {
  blkCloseStream(); // never leave a previous stream open
  const es = new EventSource('/bulk/events/' + id);
  blk.es = es;
  es.onmessage = ev => blkHandleEvent(JSON.parse(ev.data));
  es.onerror = async () => {
    if (blk.es !== es) return;
    try {
      const s = await jget('/bulk/status/' + id);
      if (['done', 'failed', 'canceled'].includes(s.status)) {
        blkEndJob();
        if (s.status === 'done') blkRenderDone(s.manifest || {});
        else {
          blkLogLine('Connection closed — batch ' + s.status + '.', 'muted');
          blkShow('setup');
        }
      }
    } catch (e) {
      blkLogLine('Connection lost — batch no longer available.', 'drop');
      blkEndJob();
      blkShow('setup');
    }
  };
}
/**
 * One SSE event on `/bulk/events/<id>`. On 'job_done' the event IS the finished manifest —
 * `blkRenderDone(ev)` below passes it straight through, so this carries every `BlkManifest`
 * field too rather than nesting one inside the other.
 * @typedef {object} BlkJobEvent
 * @property {string} type   'job_start' · 'stage' · 'progress' · 'log' · 'job_done' · 'error' ·
 *   'canceled'.
 * @property {string} [stage]   'zipping', on 'stage'.
 * @property {number} [done]
 * @property {number} [total]
 * @property {string} [line]
 * @property {string} [message]
 * @property {number} [count]
 * @property {number} [size]
 * @property {BlkMode} [mode]
 * @property {string} [format]
 * @property {string} [format_label]
 * @property {string[]} [names]
 * @property {boolean} [has_result]
 */
/** @param {BlkJobEvent} ev */
function blkHandleEvent(ev) {
  switch (ev.type) {
    case 'job_start':
      if (!blkStart) blkStart = Date.now();
      break;
    case 'stage':
      if (ev.stage === 'zipping') blkZipping();
      break;
    case 'progress':
      blk.done = /** @type {number} */ (ev.done);
      blk.total = /** @type {number} */ (ev.total);
      blkProgress();
      break;
    case 'log':
      blkLogLine(esc(ev.line), 'muted');
      break;
    case 'job_done':
      blkLogLine(`✅ Done in ${blkElapsed()} — ${ev.count} file${ev.count === 1 ? '' : 's'} zipped.`, 'ok');
      blkEndJob();
      blkRenderDone(ev);
      break;
    case 'error':
      blkLogLine('❌ ' + esc(ev.message), 'drop');
      blkEndJob();
      blkShow('setup');
      break;
    case 'canceled':
      blkLogLine('Canceled — nothing was saved.', 'muted');
      blkEndJob();
      blkShow('setup');
      break;
  }
}
